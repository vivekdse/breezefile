// breezed — the headless Breeze task daemon (breezed plan, P2).
//
// Same store + scheduler + agent executor as the GUI app, with NO
// Electron. Runs on a server so that machine owns and runs its own
// tasks; a laptop connects out over a forward ssh tunnel and reads/
// writes this daemon's HTTP API. Composes the shared, Electron-free
// route surface (electron/core/task-http.ts) — zero route/auth
// duplication with the app.
//
// Bundled by `npm run build:daemon` to daemon/dist/breezed.mjs
// (Node target, better-sqlite3 external — installed on the server).

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
import { startScheduler } from '../electron/scheduler';
// Side-effect: registers the Claude agent runner so scheduled/auto and
// /tasks/:id/run can resolve it on the server.
import '../electron/agents';

const DIR = path.join(os.homedir(), '.breezefile');
const API_FILE = path.join(DIR, 'api.json');

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
  // Scheduler after the server is up so server-side cron/auto tasks
  // fire even with no laptop attached (the whole point of the daemon).
  startScheduler();
  console.log(`[breezed] listening on 127.0.0.1:${port} (pid ${process.pid})`);
});
