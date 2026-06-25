// breezed — the headless Breeze task daemon (breezed plan, P2;
// fm-typebuild-repoint).
//
// Headless, NO Electron. Runs on a server so that machine owns and runs its
// own automated tasks. A laptop connects out over a forward ssh tunnel and
// reads/writes this daemon's HTTP API. Composes the shared, Electron-free
// route surface (electron/core/task-http.ts) — zero route/auth duplication
// with the app.
//
// SOURCE: TypeBuild (online) is the only task system. The daemon's old
// local-store scheduler half is replaced by a TypeBuild POLL-CLAIM-EXECUTE
// loop: sign in headlessly from env creds, then claim the next runnable task
// and run it through the headless executor (executeTaskRun). Browser-flagged
// tasks (chrome/playwright) are NOT run headlessly — they're released back for
// an interactive (GUI) session. The HTTP server + change-feed (run-history /
// overlay) stay intact for an attached laptop.
//
// PHI: HeadlessBreezeHost logs only opaque ids; decrypted task bodies live in
// daemon memory only (executeTaskRun runs with recordRun:false → no run row),
// never logs, never disk.
//
// Bundled by `npm run build:daemon` (daemon/build.mjs) to
// daemon/dist/breezed.mjs (Node target; better-sqlite3 + electron + node-pty
// external — the Electron/PTY graph is GUI-only and never reached headlessly).

import http, { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  writeFileSync,
  unlinkSync,
  chmodSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { setBreezeHost } from '../electron/core/host';
import type { BreezeHost } from '../electron/core/host';
import { createTaskApi, sendJson, send } from '../electron/core/task-http';
// Side-effect: registers the Claude agent runner so /tasks/:id/run and the
// TypeBuild poll-claim-execute loop can resolve it on the server.
import '../electron/agents';
import { executeTaskRun } from '../electron/agents/execute';
import { initHeadlessAuth } from '../electron/typebuild/auth';
import { TypeBuildTaskSource } from '../electron/sources/typebuild';
import type { SourcedTask } from '../electron/core/task-source';
import type { Task } from '../electron/tasks';

const DIR = path.join(os.homedir(), '.breezefile');
const API_FILE = path.join(DIR, 'api.json');
// Working directory for headless TypeBuild runs. A stable, app-owned cwd
// (never the user's home) keeps unattended sessions out of arbitrary folders.
const WORK_DIR = path.join(DIR, 'daemon-work');

// ─── TypeBuild poll-claim-execute loop ───────────────────────────────────
// Browser-based work (Claude-in-Chrome / Playwright-over-CDP) needs a real
// browser + a present human; it is NOT run headlessly. A claimed task carrying
// either flag is released back to the queue for a GUI session to pick up.
const BROWSER_FLAGS = new Set(['chrome', 'playwright']);
function isBrowserTask(flags: string[] | undefined): boolean {
  return Array.isArray(flags) && flags.some((f) => BROWSER_FLAGS.has(f));
}

// How long to wait between claim attempts when the queue is empty or after a
// run finishes. Small enough to feel responsive, large enough to be gentle on
// the server.
const POLL_IDLE_MS = 10_000;
// Concurrency cap for headless runs. The loop runs one claim at a time; this
// caps how many executions may overlap (a long run won't block claiming the
// next, but we won't pile up unbounded).
const MAX_CONCURRENT = 1;

let tbSource: TypeBuildTaskSource | null = null;
let inFlightRuns = 0;
let loopStop = false;

// A short, PHI-free fragment of an opaque task id for logs.
function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

// Build an in-memory, local-shape Task from a claimed TypeBuild task. The
// decrypted body (PHI) rides in auto_prompt so the agent runs it verbatim and
// it NEVER touches disk (executeTaskRun with recordRun:false writes no run row
// and no task row). Title/notes are left PHI-free; flags drive the run style.
function syntheticTaskFrom(claimed: SourcedTask): Task {
  const now = Date.now();
  return {
    id: claimed.id,
    // PHI-free placeholder — the real title is PHI and unused by the run.
    title: `TypeBuild task ${shortId(claimed.id)}`,
    // The decrypted body lives in auto_prompt (memory only); leave notes null
    // so nothing PHI is implied to be persistable.
    notes: null,
    status: 'in_progress',
    folder: WORK_DIR,
    start_at: null,
    due_at: null,
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: true,
    auto_agent: 'claude',
    // buildPrompt uses auto_prompt verbatim when set — the decrypted body.
    auto_prompt: claimed.notes ?? null,
    flags: Array.isArray(claimed.flags) ? claimed.flags : [],
    created_at: now,
    updated_at: now,
    completed_at: null,
    // Tag the source so executeTaskRun's PHI guard forces content-free
    // notifications for this run.
    source: 'typebuild',
  } as Task & { source: string };
}

// Run one claimed headless task end to end, then report the outcome to
// TypeBuild. PHI-free logs throughout (opaque short ids only).
async function runClaimed(source: TypeBuildTaskSource, claimed: SourcedTask) {
  const id = claimed.id;
  inFlightRuns += 1;
  try {
    const synthetic = syntheticTaskFrom(claimed);
    const { result } = await executeTaskRun(synthetic, {
      agentId: 'claude',
      manualInvocation: false,
      // No local task row exists for a remote id — suppress run-row writes.
      recordRun: false,
    });
    if (result.ok) {
      console.log(`[breezed] task ${shortId(id)} run succeeded; marking done`);
      try {
        await source.sourceAction?.(id, 'complete');
      } catch (err) {
        console.error(
          `[breezed] task ${shortId(id)} complete report failed:`,
          (err as Error).message,
        );
      }
    } else {
      // Leave the task for retry (attempts/max_attempts are server-side). We
      // release the claim so another worker / a later attempt can pick it up.
      // PHI-free: never log the result's body/content.
      console.error(
        `[breezed] task ${shortId(id)} run failed (${result.errorClass ?? 'error'}); releasing`,
      );
      try {
        await source.sourceAction?.(id, 'release', { reason: 'headless run failed' });
      } catch (err) {
        console.error(
          `[breezed] task ${shortId(id)} release failed:`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    // executeTaskRun itself threw (agent unavailable, cwd, etc.). Release so
    // the task isn't stranded as claimed-by-us.
    console.error(
      `[breezed] task ${shortId(id)} execution error:`,
      (err as Error).message,
    );
    try {
      await source.sourceAction?.(id, 'release', { reason: 'headless execution error' });
    } catch {
      /* best-effort */
    }
  } finally {
    inFlightRuns -= 1;
  }
}

// The poll-claim-execute loop. Runs forever (until shutdown). Claims one task
// per iteration; browser tasks are released for a GUI session; headless tasks
// run end to end. Honors MAX_CONCURRENT and never lets a single error kill the
// loop.
async function typeBuildLoop(source: TypeBuildTaskSource) {
  console.log('[breezed] TypeBuild poll-claim-execute loop started');
  while (!loopStop) {
    try {
      if (inFlightRuns >= MAX_CONCURRENT) {
        await delay(POLL_IDLE_MS);
        continue;
      }
      const claimed = await source.claimNext();
      if (!claimed) {
        // Empty queue — wait and retry.
        await delay(POLL_IDLE_MS);
        continue;
      }
      if (isBrowserTask(claimed.flags)) {
        // Browser-based work is not run headlessly — release for a GUI
        // session that can host the browser + a present human.
        console.log(
          `[breezed] task ${shortId(claimed.id)} is browser-based; releasing for an interactive session`,
        );
        try {
          await source.sourceAction?.(claimed.id, 'release', {
            reason: 'browser task — needs an interactive session',
          });
        } catch (err) {
          console.error(
            `[breezed] task ${shortId(claimed.id)} release failed:`,
            (err as Error).message,
          );
        }
        // Brief pause so we don't immediately re-claim the same task in a hot
        // loop if the server hands it back to us.
        await delay(POLL_IDLE_MS);
        continue;
      }
      // Headless-safe: run it. Fire-and-forget under the concurrency cap so a
      // long run doesn't block the next claim once a slot frees.
      void runClaimed(source, claimed);
      // Small spacing between claims so we don't burst the server.
      await delay(500);
    } catch (err) {
      // claimNext or an unexpected throw — log PHI-free and back off.
      console.error('[breezed] loop error:', (err as Error).message);
      await delay(POLL_IDLE_MS);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Change feed ─────────────────────────────────────────────────────
// A monotonically-increasing sequence the laptop long-polls so it can
// refresh without busy polling. Bumped on every task/run change.
let seq = 0;
let waiters: Array<(s: number) => void> = [];

function bump() {
  seq += 1;
  const w = waiters;
  waiters = [];
  for (const resolve of w) resolve(seq);
}

const HeadlessBreezeHost: BreezeHost = {
  onTasksChanged() {
    bump();
  },
  onRunsChanged() {
    bump();
  },
  onRunFailed(task, body) {
    console.error(`[breezed] auto-run failed: ${task.title} — ${body}`);
  },
  // fm-h8g7 — headless has no OS-notification surface; just log. The remote
  // transition feed carries only opaque ids (PHI-free) so it's safe to log.
  onRunSucceeded(task, body) {
    console.log(`[breezed] auto-run succeeded: ${task.title} — ${body}`);
  },
  onTaskTransitions(transitions) {
    if (transitions.length === 0) return;
    console.log(
      `[breezed] ${transitions.length} remote task transition(s): ` +
        transitions.map((t) => `${t.taskId.slice(0, 8)}:${t.kind}`).join(', '),
    );
  },
};

// ─── Server ──────────────────────────────────────────────────────────
const token = crypto.randomBytes(24).toString('base64url');
const taskApi = createTaskApi(() => token);

function writeApiFile(port: number) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(
    API_FILE,
    JSON.stringify({ port, token, pid: process.pid }, null, 2),
    'utf8',
  );
  try {
    chmodSync(API_FILE, 0o600);
  } catch {
    /* non-fatal */
  }
}

function clearApiFile() {
  try {
    unlinkSync(API_FILE);
  } catch {
    /* already gone */
  }
}

// Long-poll: resolve as soon as seq advances past `since`, or after a
// timeout with the current seq (keeps the tunnel/connection warm).
const LONG_POLL_MS = 25_000;

function handleChanges(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const since = Number(url.searchParams.get('since') ?? '0') || 0;
  if (seq > since) return sendJson(res, 200, { seq });
  let done = false;
  const finish = (s: number) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sendJson(res, 200, { seq: s });
  };
  const timer = setTimeout(() => finish(seq), LONG_POLL_MS);
  waiters.push(finish);
  req.on('close', () => {
    done = true;
    clearTimeout(timer);
    waiters = waiters.filter((w) => w !== finish);
  });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (taskApi.tryHealthz(req, res)) return;
  if (!taskApi.authorized(req)) return send(res, 401, 'unauthorized');

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/tasks/changes' && (req.method ?? 'GET') === 'GET') {
    return handleChanges(req, res);
  }

  if (await taskApi.route(req, res)) return;
  return send(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  void route(req, res);
});

server.on('error', (err) => {
  console.error('[breezed] server error:', err);
  process.exit(1);
});

function shutdown() {
  loopStop = true;
  // Disarm any source-side timers (keep-alives) if the loop ever started one.
  try {
    tbSource?.stopPolling();
  } catch {
    /* ignore */
  }
  clearApiFile();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setBreezeHost(HeadlessBreezeHost);

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  writeApiFile(port);
  console.log(`[breezed] listening on 127.0.0.1:${port} (pid ${process.pid})`);
  // Start the TypeBuild loop after the server is up so run-history/overlay
  // routes are served immediately even before sign-in completes.
  void startTypeBuildLoop();
});

// Sign in headlessly from env creds and start the poll-claim-execute loop. If
// TYPEBUILD_EMAIL / TYPEBUILD_PASSWORD are unset, log a clear warning and run
// WITHOUT the loop — the HTTP server still serves task-http (run-history /
// overlay) so a laptop can attach.
async function startTypeBuildLoop(): Promise<void> {
  let authed;
  try {
    authed = await initHeadlessAuth();
  } catch (err) {
    console.error(
      '[breezed] TypeBuild sign-in failed:',
      (err as Error).message,
      '— running WITHOUT the TypeBuild loop',
    );
    return;
  }
  if (!authed) {
    console.warn(
      '[breezed] TYPEBUILD_EMAIL / TYPEBUILD_PASSWORD not set — running ' +
        'WITHOUT the TypeBuild loop (HTTP server still serves run-history/overlay)',
    );
    return;
  }
  console.log(`[breezed] signed in to TypeBuild as ${authed.email}`);
  // Ensure the headless work dir exists (executeTaskRun needs a real cwd).
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  // Hold a source instance and call claimNext() directly. We do NOT call
  // startPolling() — that's the GUI notification surface (it pauses without a
  // BrowserWindow anyway). The loop owns claiming.
  tbSource = new TypeBuildTaskSource();
  void typeBuildLoop(tbSource);
}
