// task-48cd46a0e2da — the PURE decision at the heart of the shared start
// wrapper (useStartAction): given a start attempt (and, for a real launch, its
// resolved StartOutcome), what VISIBLE feedback must the UI show? The whole
// point is that this function NEVER returns "nothing" — every start click ends
// as either a pending state or an error with a reason. Extracted here (no
// React) so the never-silent invariant is unit-testable.

/**
 * @typedef {{ kind: 'start' } | { kind: 'none', reason: string }} StartAttemptKind
 * @typedef {{ ok: boolean, spawned?: boolean, message?: string }} StartOutcomeLike
 */

/**
 * Classify the FINAL feedback for a start attempt.
 *
 *   - attempt kind 'none'  → { state:'error', reason } (surface why nothing ran)
 *   - attempt kind 'start', outcome spawned  → { state:'pending' }
 *   - attempt kind 'start', outcome failed   → { state:'error', reason }
 *
 * `outcome` is required only for kind 'start'. A missing/garbled outcome for a
 * 'start' is treated as an error (never a silent success), upholding the
 * invariant that the result is always pending OR error.
 *
 * @param {StartAttemptKind} attempt
 * @param {StartOutcomeLike | null | undefined} [outcome]
 * @returns {{ state: 'pending' } | { state: 'error', reason: string }}
 */
export function classifyStartFeedback(attempt, outcome) {
  if (!attempt || attempt.kind === 'none') {
    const reason =
      attempt && typeof attempt.reason === 'string' && attempt.reason
        ? attempt.reason
        : 'nothing to start';
    return { state: 'error', reason };
  }
  // kind === 'start'
  if (outcome && outcome.ok && outcome.spawned) {
    return { state: 'pending' };
  }
  if (outcome && outcome.ok && !outcome.spawned) {
    return { state: 'error', reason: 'start did not spawn a session' };
  }
  const reason =
    outcome && typeof outcome.message === 'string' && outcome.message
      ? outcome.message
      : 'start failed';
  return { state: 'error', reason };
}
