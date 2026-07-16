// task-710003dbc2c6 (U3) — the SHARED stop-action wrapper, mirroring
// useStartAction's contract (see useStartAction.ts's header for why this
// pattern exists: no start/stop affordance may ever click through to
// silence). Owns per-key pending/error UI so any surface (roster row,
// detail dialog/panel) can drive many independent Stop buttons from one
// instance.

import { useCallback, useRef, useState } from 'react';
import type { Task } from '../../types';
import { useTaskActions } from './useTaskActions';

export type UseStopAction = {
  /** True while a stop attempt for `key` is in flight (optimistic "Stopping…"). */
  pendingFor: (key: string) => boolean;
  /** The last error/status message for `key`, or null. */
  errorFor: (key: string) => string | null;
  clear: (key: string) => void;
  /** Attempt to stop `task` (keyed by `key`, usually task.id). Always
   *  resolves — never throws — and always leaves a visible pending/result
   *  state for the key, same never-silent contract useStartAction enforces
   *  for Start. */
  run: (key: string, task: Task, session?: { ptyId: number }) => Promise<void>;
};

export function useStopAction(): UseStopAction {
  const actions = useTaskActions();
  const [pending, setPending] = useState<Record<string, true>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
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
    async (key: string, task: Task, session?: { ptyId: number }) => {
      if (pendingRef.current[key]) return;
      clear(key);
      setPendingKey(key, true);
      try {
        const { ok, message } = await actions.stop(task, session);
        setPendingKey(key, false);
        // Surface both success and failure text — a quiet success confirms
        // the click landed; a failure never disappears silently.
        setErrors((prev) => ({ ...prev, [key]: message }));
        if (ok) {
          // Clear the transient confirmation shortly after so the row
          // doesn't carry a permanent "stopped" caption once the server's
          // own status catches up.
          setTimeout(() => clear(key), 4000);
        }
      } catch (e) {
        setPendingKey(key, false);
        const message = e instanceof Error ? e.message : String(e);
        setErrors((prev) => ({ ...prev, [key]: message }));
      }
    },
    [actions, clear, setPendingKey],
  );

  return { pendingFor, errorFor, clear, run };
}
