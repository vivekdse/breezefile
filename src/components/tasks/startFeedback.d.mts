// task-48cd46a0e2da — type surface for the pure start-feedback classifier.

export type StartAttemptKind = { kind: 'start' } | { kind: 'none'; reason: string };
export type StartOutcomeLike = { ok: boolean; spawned?: boolean; message?: string };

export function classifyStartFeedback(
  attempt: StartAttemptKind,
  outcome?: StartOutcomeLike | null,
): { state: 'pending' } | { state: 'error'; reason: string };
