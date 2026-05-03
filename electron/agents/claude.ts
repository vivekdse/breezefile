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
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TaskRunErrorClass } from '../tasks';
import type { AgentRunInput, AgentRunResult, AgentRunner } from './types';

const CLAUDE_BIN = 'claude';

class ClaudeAgent implements AgentRunner {
  readonly id = 'claude';
  readonly label = 'Claude Code';

  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const c = spawn(CLAUDE_BIN, ['--version'], { stdio: 'ignore' });
      c.on('error', () => resolve(false));
      c.on('exit', (code) => resolve(code === 0));
    });
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { prompt, cwd, taskId, runId, outputDir, signal } = input;
    const stdoutPath = path.join(outputDir, 'stream.jsonl');
    const stderrPath = path.join(outputDir, 'stderr.log');
    const metaPath = path.join(outputDir, 'meta.json');

    const args = [
      '-p',
      prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--add-dir', cwd,
    ];

    await writeFile(
      metaPath,
      JSON.stringify(
        {
          runId,
          taskId,
          agent: this.id,
          command: CLAUDE_BIN,
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
    const child = spawn(CLAUDE_BIN, args, {
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
