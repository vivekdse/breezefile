// task-b8306d2b85c2 — type surface for the pure lifecycle.mjs module (runtime
// is plain ESM so the node test runner can import it without a transpile step).
import type { Task, TaskAuditEvent } from '../../types';

export const CLAIM_TTL_MS: number;

export function relAge(ms: number): string;

export interface ClaimFreshness {
  /** "12m ago" / "1h 50m ago" / "just now". */
  relative: string;
  ageMs: number;
  expired: boolean;
  expiresSoon: boolean;
}

export function claimFreshness(
  claimedAt: string | number | null | undefined,
  now?: number,
): ClaimFreshness | null;

export function claimSummary(
  claimedBy: string | null,
  claimedByMe: boolean,
  claimedAt: string | number | null | undefined,
  now?: number,
): string;

export function shortActor(user: string): string;

/** A timeline lane. NON-PHI: actor (email/principal) + timestamps + verb. */
export type TimelineKind =
  | 'created'
  | 'claimed'
  | 'renewed'
  | 'released'
  | 'status';

export interface TimelineEvent {
  kind: TimelineKind | string;
  label: string;
  actor: string | null;
  at: string | null;
  detail: string;
}

export function buildTimeline(
  events: TaskAuditEvent[] | null | undefined,
  task?: Partial<
    Pick<Task, 'createdAtIso' | 'createdBy' | 'claimedAt' | 'claimedBy'>
  >,
): TimelineEvent[];
