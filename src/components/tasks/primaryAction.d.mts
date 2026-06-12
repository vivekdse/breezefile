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
}

export type PrimaryAction =
  | { kind: 'done-toggle'; done: boolean }
  | { kind: 'start'; enabled: boolean; tooltip?: string }
  | { kind: 'open-session'; tabIndex: number }
  | { kind: 'reopen' }
  | { kind: 'run-now' }
  | { kind: 'view-run' }
  | { kind: 'none'; note?: string };

export function primaryActionFor(task: Task, ctx: PrimaryActionCtx): PrimaryAction;
