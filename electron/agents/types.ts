// Agent abstraction for auto-executing tasks (epic fm-zf3m).
//
// The scheduler picks a runner from the registry by id, hands it a
// resolved prompt + cwd + a writable output directory, and waits for an
// AgentRunResult. The runner owns the subprocess; the scheduler owns
// queueing, retries, and DB writes. Adding a new agent (Codex, Gemini,
// a generic shell) means dropping a new file into electron/agents/ and
// calling register() — no changes to scheduler/UI.

import type { TaskRunErrorClass } from '../tasks';

export type AgentId = string;

export type AgentRunInput = {
  /** Resolved prompt: auto_prompt override OR title + notes. Plain text. */
  prompt: string;
  /** Working directory (task.folder). Also passed via --add-dir to claude. */
  cwd: string;
  taskId: string;
  /** Our task_runs.id. Surfaces in log filenames so support can find runs
   *  by grepping output, and lets the runner emit progress IPC keyed to
   *  the right row. */
  runId: string;
  /** Directory the runner should write its logs to (created by caller).
   *  Convention: stream.jsonl + stderr.log + meta.json. */
  outputDir: string;
  signal: AbortSignal;
  /** Extra env. The runner adds its own (e.g. BREEZE_TASK_ID). */
  env?: Record<string, string>;
};

export type AgentRunResult = {
  ok: boolean;
  /** Conversation / session id reported by the agent, if any. For
   *  Claude this is the resumable session_id; UI uses it to surface
   *  "open this trace" via `claude --resume`. */
  conversationId: string | null;
  exitCode: number | null;
  durationMs: number;
  errorClass?: TaskRunErrorClass;
  errorMessage?: string;
};

export interface AgentRunner {
  readonly id: AgentId;
  readonly label: string;
  /** True if the runner can execute right now (binary present, auth
   *  configured, etc.). Used to pre-flight before the scheduler queues
   *  a run, so we surface "claude not installed" as a configuration
   *  error rather than a run failure. */
  available(): Promise<boolean>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
