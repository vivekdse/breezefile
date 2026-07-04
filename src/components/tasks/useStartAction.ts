// task-48cd46a0e2da — the SHARED start-action wrapper.
//
// THE RECURRING DEFECT of the entire QA night was a SILENT start click: a ▶
// (parent Start-chain, per-step ▶, auto-continue, manual Start/Retry) that
// yielded ZERO visible feedback — no claim, no session, no optimistic UI, no
// error. Retry round 2, auto-continue rounds 4-7, and Start-chain (round 8) all
// died the same way. This wrapper makes that class of bug IMPOSSIBLE: EVERY
// start attempt routed through it produces, within one tick, either
//   - a PENDING state (optimistic "starting…"), or
//   - an ERROR state with a human reason ("no runnable step: deliver is
//     cancelled", "launch failed: <err>", "task not found").
// It never returns a silent no-op.
//
// It owns per-key pending/error UI state (keyed by whatever the caller keys on —
// a task id, a chain parent id, a step def id) so a single component can drive
// many independent Start affordances. Callers read `pendingFor`/`errorFor` to
// render the optimistic/error UI, and call `run(key, fn)` to attempt a start.

import { useCallback, useRef, useState } from 'react';
import type { StartOutcome } from './useTaskActions';
import { classifyStartFeedback } from './startFeedback.mjs';

/** The result of one start attempt. `run` always resolves to one of these —
 *  never undefined, never a swallowed throw. */
export type StartActionResult =
  | { ok: true; pending: true }
  | { ok: false; reason: string };

/** What a caller's start function must resolve to. `null`/undefined means
 *  "there was nothing runnable to start" and MUST carry a reason so the wrapper
 *  can surface it instead of no-oping. */
export type StartAttempt =
  | { kind: 'start'; run: () => Promise<StartOutcome> }
  | { kind: 'none'; reason: string };

export type UseStartAction = {
  /** True while a start attempt for `key` is in flight (optimistic pending). */
  pendingFor: (key: string) => boolean;
  /** The last error reason for `key`, or null. Cleared when a new attempt for
   *  the same key begins, or via `clear(key)`. */
  errorFor: (key: string) => string | null;
  /** Clear a key's error (e.g. a manual retry, or dismiss). */
  clear: (key: string) => void;
  /**
   * Attempt a start for `key`. `attempt` either describes a real start
   * (`kind:'start'` with a promise-returning `run`) or an explicit
   * `kind:'none'` with a REASON (e.g. "no runnable step: deliver is
   * cancelled"). Guarantees visible feedback:
   *   - 'none'  → sets the error to the reason, returns { ok:false, reason }.
   *   - 'start' → sets pending immediately, awaits the StartOutcome; on
   *               failure records the outcome's message as the error.
   * Concurrency-guarded: a second call for a key already pending is ignored
   * (returns the pending result) so a double-click can't double-launch.
   */
  run: (key: string, attempt: StartAttempt) => Promise<StartActionResult>;
};

export function useStartAction(): UseStartAction {
  const [pending, setPending] = useState<Record<string, true>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Ref mirror of pending so `run`'s concurrency guard sees the latest value
  // synchronously (state updates are async; a fast double-click would both
  // read the stale `false`).
  const pendingRef = useRef<Record<string, true>>({});

  const setPendingKey = useCallback((key: string, on: boolean) => {
    pendingRef.current = { ...pendingRef.current };
    if (on) pendingRef.current[key] = true;
    else delete pendingRef.current[key];
    setPending({ ...pendingRef.current });
  }, []);

  const pendingFor = useCallback((key: string) => !!pending[key], [pending]);
  const errorFor = useCallback((key: string) => errors[key] ?? null, [errors]);
  const clear = useCallback((key: string) => {
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const run = useCallback(
    async (key: string, attempt: StartAttempt): Promise<StartActionResult> => {
      // Guard: never double-fire a start for a key already in flight.
      if (pendingRef.current[key]) return { ok: true, pending: true };

      // Explicit "nothing runnable" — surface the reason, never a silent no-op.
      if (attempt.kind === 'none') {
        const fb = classifyStartFeedback({ kind: 'none', reason: attempt.reason });
        const reason = fb.state === 'error' ? fb.reason : attempt.reason;
        setErrors((prev) => ({ ...prev, [key]: reason }));
        return { ok: false, reason };
      }

      // Optimistic pending + clear any stale error, synchronously via the ref.
      clear(key);
      setPendingKey(key, true);
      try {
        const outcome = await attempt.run();
        const fb = classifyStartFeedback({ kind: 'start' }, outcome);
        setPendingKey(key, false);
        if (fb.state === 'pending') {
          // Real, live session. The roster's own server-truth derivation
          // (isInProgress) now shows RUNNING; the local optimistic flag is
          // dropped so the two don't fight.
          return { ok: true, pending: true };
        }
        setErrors((prev) => ({ ...prev, [key]: fb.reason }));
        return { ok: false, reason: fb.reason };
      } catch (e) {
        // Defensive: useTaskActions().start is contracted never to throw, but
        // if any wrapped fn ever does, we STILL surface it — never silent.
        const reason = e instanceof Error ? e.message : String(e);
        setPendingKey(key, false);
        setErrors((prev) => ({ ...prev, [key]: reason }));
        return { ok: false, reason };
      }
    },
    [clear, setPendingKey],
  );

  return { pendingFor, errorFor, clear, run };
}
