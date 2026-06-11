// Claude Code agent runner (epic fm-zf3m).
//
// Spawns `claude -p <prompt> --output-format stream-json --verbose
// --permission-mode acceptEdits --add-dir <cwd>`, captures stdout
// (JSONL) and stderr to the run's output directory, parses the trailing
// `result` event for session_id and ok/error info, and classifies
// failures so the scheduler can decide whether to retry.
//
// Why stream-json + --verbose:
//   - Future UI wants to tail the run. JSONL is easy to render.
//   - The `result` event at end-of-stream carries session_id + cost +
//     duration + is_error. That's the canonical exit signal even when
//     the process exits 0 with an internal error.
//
// Why acceptEdits:
//   - The whole point of auto-mode is unattended execution in the task
//     folder. `plan` mode would refuse all writes, defeating the
//     feature. We can promote this to a per-task setting later.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TaskRunErrorClass } from '../tasks';
import { flagsToArgs } from './flags';
import type { AgentRunInput, AgentRunResult, AgentRunner } from './types';

// When the app is launched from Dock / Finder / Spotlight, macOS gives
// it a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't
// include the user's `~/.local/bin`, Homebrew, nvm shims, etc. — so a
// bare `spawn('claude', …)` fails with ENOENT. Resolve to an absolute
// path once per process: try common install locations, then fall back
// to a login-shell `command -v` so the user's profile loads PATH.
let resolvedBin: Promise<string> | null = null;

function probeWellKnown(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function probeLoginShell(): Promise<string | null> {
  return new Promise((resolve) => {
    const c = spawn('/bin/zsh', ['-lc', 'command -v claude'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => {
      const p = out.trim().split('\n').pop() || '';
      resolve(code === 0 && p && existsSync(p) ? p : null);
    });
  });
}

export async function resolveClaudeBin(): Promise<string> {
  if (resolvedBin) return resolvedBin;
  resolvedBin = (async () => {
    const wk = probeWellKnown();
    if (wk) return wk;
    const ls = await probeLoginShell();
    if (ls) return ls;
    // Last-resort fallback: bare name. Will ENOENT in the bad-PATH
    // case, but at least preserves the prior behavior in dev.
    return 'claude';
  })();
  return resolvedBin;
}

class ClaudeAgent implements AgentRunner {
  readonly id = 'claude';
  readonly label = 'Claude Code';

  async available(): Promise<boolean> {
    const bin = await resolveClaudeBin();
    return new Promise((resolve) => {
      const c = spawn(bin, ['--version'], { stdio: 'ignore' });
      c.on('error', () => resolve(false));
      c.on('exit', (code) => resolve(code === 0));
    });
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { prompt, cwd, taskId, runId, outputDir, signal } = input;
    const bin = await resolveClaudeBin();
    const stdoutPath = path.join(outputDir, 'stream.jsonl');
    const stderrPath = path.join(outputDir, 'stderr.log');
    const metaPath = path.join(outputDir, 'meta.json');

    // fm-b5at.7 — per-task flags (chrome/auto/resume/...) map to extra
    // claude args here, superseding the prior hardcoded --chrome. A headless
    // run with no flags is the original plain `claude -p` behavior. We
    // always set --permission-mode acceptEdits for headless runs (the
    // unattended baseline); the 'auto' flag re-emits the same mode and is
    // a no-op overlap, by design — both mean "permissive but still gated".
    const { args: flagArgs, unknown: unknownFlags } = flagsToArgs(input.flags);
    if (unknownFlags.length) {
      console.warn('[claude] ignoring unknown task flags:', unknownFlags.join(', '));
    }
    const args = [
      '-p',
      buildPreamble(taskId, runId) + prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--add-dir', cwd,
      ...flagArgs,
    ];

    await writeFile(
      metaPath,
      JSON.stringify(
        {
          runId,
          taskId,
          agent: this.id,
          command: bin,
          args,
          cwd,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );

    const start = performance.now();
    const stdoutStream = createWriteStream(stdoutPath, { flags: 'a' });
    const stderrStream = createWriteStream(stderrPath, { flags: 'a' });

    // Strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN before spawning. The
    // Claude CLI's auth precedence is env-var > stored OAuth credentials,
    // so leaking a stale `export ANTHROPIC_API_KEY=…` from the user's
    // shell rc into Electron causes headless runs to fail with
    // "Invalid API key" even when the user's interactive subscription
    // login is healthy. We want headless runs to use the same OAuth
    // login the user uses interactively, so we drop these vars and let
    // the CLI fall through to the stored credentials. Caller-supplied
    // env (input.env) still wins — that's the explicit override path.
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.ANTHROPIC_API_KEY;
    delete baseEnv.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...baseEnv,
        ...(input.env ?? {}),
        BREEZE_TASK_ID: taskId,
        BREEZE_RUN_ID: runId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Buffer stdout in memory too so we can find the final `result`
    // event at exit. JSONL output is small for normal runs; if it
    // grows unbounded we'd switch to a tail-parse approach.
    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stdoutBuf += s;
      stdoutStream.write(s);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderrBuf += s;
      stderrStream.write(s);
    });

    const onAbort = () => {
      // Send SIGTERM; claude flushes its output and exits cleanly.
      // SIGKILL fallback after 5s if it doesn't.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, 5000).unref();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const exitInfo = await new Promise<{
      code: number | null;
      sigKilled: boolean;
      err: Error | null;
    }>((resolve) => {
      let resolved = false;
      const finish = (v: { code: number | null; sigKilled: boolean; err: Error | null }) => {
        if (resolved) return;
        resolved = true;
        resolve(v);
      };
      child.on('error', (err) => finish({ code: null, sigKilled: false, err }));
      child.on('exit', (code, sig) =>
        finish({ code, sigKilled: sig === 'SIGTERM' || sig === 'SIGKILL', err: null }),
      );
    });

    stdoutStream.end();
    stderrStream.end();
    const durationMs = Math.round(performance.now() - start);

    if (exitInfo.err) {
      return {
        ok: false,
        conversationId: null,
        exitCode: null,
        durationMs,
        errorClass: 'fatal',
        errorMessage: exitInfo.err.message,
      };
    }

    if (signal.aborted || exitInfo.sigKilled) {
      return {
        ok: false,
        conversationId: extractSessionId(stdoutBuf),
        exitCode: exitInfo.code,
        durationMs,
        errorClass: 'transient',
        errorMessage: 'cancelled',
      };
    }

    const parsed = parseFinalResult(stdoutBuf);
    const conversationId = parsed?.session_id ?? extractSessionId(stdoutBuf);
    const exitCode = exitInfo.code;

    // Two failure paths: process exited non-zero, OR the result event
    // says is_error=true (claude can exit 0 on usage limit / mid-turn
    // errors and report via the JSON envelope).
    const isError = exitCode !== 0 || parsed?.is_error === true;
    if (!isError) {
      return {
        ok: true,
        conversationId,
        exitCode,
        durationMs,
      };
    }

    const cls = classifyError(stderrBuf, parsed);
    const msg =
      parsed?.result ||
      firstLine(stderrBuf) ||
      `claude exited ${exitCode}`;
    return {
      ok: false,
      conversationId,
      exitCode,
      durationMs,
      errorClass: cls,
      errorMessage: msg,
    };
  }
}

// Standing instruction prepended to every auto-run prompt. Auto-mode is
// non-interactive: a denied tool call has no human to escalate to and
// would otherwise either get silently worked around or cause the agent
// to thrash. Instead, instruct the agent to file a manual Breeze task
// naming the exact tool/pattern needed and stop. The user sees that
// task in their list, reviews it, and adds the pattern to
// .claude/settings.json. `Bash(breeze *)` must be pre-allowed in
// project settings so this escape valve isn't itself blocked.
function buildPreamble(taskId: string, runId: string): string {
  return [
    'You are running unattended in Breeze auto-task mode (no human in the loop).',
    '',
    'If a tool call is denied by permissions, do NOT retry, work around it,',
    'or attempt an alternative tool to accomplish the same effect. Instead:',
    '  1. File a manual Breeze task so the user can see and act on it:',
    `       breeze add "Permission needed: <tool/pattern>" \\`,
    `         --notes "Task ${taskId} run ${runId} needed <tool> to <reason>. Add the pattern to .claude/settings.json allow list, then re-run."`,
    '  2. Stop and exit. The user will grant the permission and re-run.',
    '',
    '--- task prompt below ---',
    '',
    '',
  ].join('\n');
}

type ResultEvent = {
  type: 'result';
  session_id?: string;
  is_error?: boolean;
  /** Stream-json puts the human-readable message here when is_error is
   *  true (e.g. "Invalid API key · Fix external API key"). NOT `error`. */
  result?: string;
  /** Anthropic API HTTP status when the error came from the API
   *  (401/403 auth, 429 rate-limit, 5xx transient, etc.). */
  api_error_status?: number;
  // other fields ignored for now (cost, duration_ms, etc.)
};

/** Find the trailing JSONL `result` event. Stream-json terminates with
 *  a single result line — we walk backwards to handle interspersed
 *  events that might trail. Safe on partial / malformed streams. */
function parseFinalResult(buf: string): ResultEvent | null {
  const lines = buf.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === 'result') return obj as ResultEvent;
    } catch { /* not JSON, skip */ }
  }
  return null;
}

/** Best-effort: scan forward for any event carrying a session_id, in
 *  case we never got a `result` line (mid-stream crash). */
function extractSessionId(buf: string): string | null {
  for (const line of buf.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.session_id === 'string') return obj.session_id;
    } catch { /* skip */ }
  }
  return null;
}

function firstLine(s: string): string | null {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 500);
  }
  return null;
}

/** Map noisy stderr / result strings to a coarse class so the scheduler
 *  can decide retry vs. give up. Prefer the structured api_error_status
 *  when present — it's the source of truth from Anthropic's API. Fall
 *  back to keyword matching for non-API errors (CLI bugs, network).
 *  Conservative default: 'transient' so we retry once before giving up. */
export function classifyError(
  stderr: string,
  parsed: ResultEvent | null,
): TaskRunErrorClass {
  const status = parsed?.api_error_status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && status >= 500) return 'transient';

  const blob = `${stderr}\n${parsed?.result ?? ''}`.toLowerCase();
  if (/rate[- ]?limit|too many requests/.test(blob)) return 'rate_limit';
  if (/usage limit|quota|insufficient (credit|quota)|monthly limit/.test(blob)) {
    return 'usage';
  }
  if (/unauthor|not authenticated|invalid api key|forbidden/.test(blob)) {
    return 'auth';
  }
  if (/timeout|timed out|econn|enotfound|network|socket hang up/.test(blob)) {
    return 'transient';
  }
  return 'transient';
}

export const claudeAgent = new ClaudeAgent();
