// task-80be320f06b3 — type surface for the pure vitals.mjs module (runtime is
// plain ESM so the node test runner imports it without a transpile step).
import type { Task, TaskAuditEvent } from '../../types';

export const CLAIM_TTL_MS: number;

/** Newest audit event overall (the task's "last activity"). NON-PHI. */
export interface LastActivity {
  at: string;
  actor: string | null;
  /** lower-cased action verb (NON-PHI) */
  action: string;
  ms: number;
}

export function lastActivity(
  events: TaskAuditEvent[] | null | undefined,
): LastActivity | null;

/** When the task entered its current status (from the audit status-lane). */
export interface EnteredStatus {
  at: string;
  ms: number;
  action: string | null;
  source: 'audit' | 'created';
}

export function enteredCurrentStatusAt(
  events: TaskAuditEvent[] | null | undefined,
  task?: Pick<Task, 'createdAtIso'>,
): EnteredStatus | null;

export function shortDay(at: string | number | null | undefined): string;

export function hasLiveClaim(
  task: Pick<Task, 'claimedBy' | 'claimedAt'>,
  now?: number,
): boolean;

export type VitalsSeverity = 'ok' | 'warn' | 'over';

export interface TimeInStatus {
  /** elapsed ms in current status, or null when entry time unknown. */
  ms: number | null;
  /** "In progress · 6d" */
  label: string;
  /** "6d" (no suffix) */
  since: string;
  /** "Jun 22" */
  sinceDay: string;
  severity: VitalsSeverity;
  status: string;
}

export function timeInStatus(
  task: Pick<Task, 'status' | 'claimedBy' | 'claimedAt'>,
  enteredAtMs: number | null,
  now?: number,
): TimeInStatus;

export function compactDuration(ms: number): string;

export function isStalled(
  task: Pick<Task, 'status' | 'claimedBy' | 'claimedAt'>,
  enteredAtMs: number | null,
  now?: number,
): boolean;

export function statusDotHealth(
  task: Pick<Task, 'status' | 'claimedBy' | 'claimedAt'>,
  enteredAtMs: number | null,
  now?: number,
): 'stalled' | 'lapsed' | null;

export function lastActivitySummary(
  la: LastActivity | null,
  now?: number,
): string;
