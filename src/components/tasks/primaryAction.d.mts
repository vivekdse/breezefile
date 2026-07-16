// fm-7909 — type surface for the pure primaryAction.mjs module.
import type { Task, TaskSourceCapabilities } from '../../types';

export interface TbReadiness {
  signedIn: boolean;
  claudeOk: boolean;
  chromeOk: boolean;
  ready: boolean;
}

export interface PrimaryActionCtx {
  caps?: TaskSourceCapabilities;
  tbReady?: TbReadiness;
  myEmail?: string | null;
  /** A live session tab bound to this task, if any. */
  session?: { ptyId: number; tabIndex: number };
  /** Local auto-mode: a run is currently in flight. */
  lastRunRunning?: boolean;
  /** fm-bq86 (S3) — a parent with non-terminal children loses Start. */
  hasOpenChildren?: boolean;
}

export type PrimaryAction =
  | { kind: 'done-toggle'; done: boolean }
  /** `reentry` marks a launch-first re-open of a terminal (done/partial/
   *  cancelled) task — same launch path, but the button reads "Open operator"
   *  rather than "Start". */
  | { kind: 'start'; enabled: boolean; tooltip?: string; reentry?: boolean }
  | { kind: 'open-session'; tabIndex: number }
  | { kind: 'reopen' }
  /** task-457dd1cc6c8b — a blocked TypeBuild task: Retry runs the composite
   *  reopen→claim→launch chain (see useStartAction). `reason` is a human
   *  sentence (never a raw server token) for the button tooltip/status line. */
  | { kind: 'retry'; reason: string }
  | { kind: 'run-now' }
  | { kind: 'view-run' }
  | { kind: 'none'; note?: string };

export function primaryActionFor(task: Task, ctx: PrimaryActionCtx): PrimaryAction;

/** task-c141c7765aa4 — true when the server (or normalized status) says a
 *  session is currently running for this task. */
export function isInProgress(task: Task): boolean;

/** task-710003dbc2c6 (U3) — one action id per verb a surface can render.
 *  `reason` is a human sentence: the tooltip when disabled, or supporting
 *  context when enabled (e.g. Retry's "blocked after N/M attempts"). */
export interface TaskAction {
  id:
    | 'start'
    | 'stop'
    | 'retry'
    | 'cancel'
    | 'reopen'
    | 'answer'
    | 'open-session'
    | 'view-run'
    | 'done-toggle';
  label: string;
  enabled: boolean;
  reason?: string;
}

/** The full ordered action list for `task` — the superset primaryActionFor's
 *  single decision is drawn from, plus STOP/CANCEL/ANSWER. Every surface
 *  (roster row menu, detail dialog/panel, future copilot) renders from this
 *  instead of hardcoding which verbs exist. */
export function actionsFor(task: Task, ctx: PrimaryActionCtx): TaskAction[];
