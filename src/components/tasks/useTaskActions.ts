// fm-7909 / fm-b5at — capability-aware, task-object-first mutation helpers.
//
// The systemic bug this fixes: the old page called updateTask(task.id) /
// deleteTask(task.id) WITHOUT task.source, so every TypeBuild mutation routed
// to local SQLite where the id doesn't exist → silent no-op or throw. Every
// helper here passes task.source AND checks the owning source's capabilities
// BEFORE the IPC call: an unsupported action becomes a calm status line, never
// an exception. bulkPatch additionally partitions by capability and reports
// the skipped count.

import { useCallback } from 'react';
import { useStore } from '../../store';
import {
  deleteTask,
  runTaskNow,
  taskSourceAction,
  updateTask,
  useTaskSources,
} from '../../tasks';
import { formatOpError, formatSourceReason } from '../../errorMessages';
import { launchErrorReason, mintErrorReason, spawnedOutcome } from './startOutcome.mjs';
import type { Task, TaskSourceCapabilities, TaskStatus, TaskUpdate } from '../../types';

// fm-b5at.9 / task-3f0c6a6abe41 — the mint + launch failure reason mappers
// and the "did a real session spawn?" decision live in the pure, unit-tested
// startOutcome.mjs (mintErrorReason / launchErrorReason / spawnedOutcome),
// imported above. This hook is not itself unit-testable under `node --test`,
// so the correctness-critical logic is factored out where it can be asserted.

// fm-iwlc (S6) — the typebuild source throws a `[typebuild-delete:<reason>]`
// tagged Error on a rejected delete (IPC strips custom Error props, so the
// reason rides in the message). Pull the machine reason out so the caller can
// route it through formatSourceReason (not_owner / in_progress_elsewhere → a
// distinct status-line sentence). Returns null for any other error.
function deleteReason(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-delete:([a-z_]+)\]/.exec(raw);
  return m ? m[1] : null;
}

const STATUS_VERBED: Record<TaskStatus, string> = {
  pending: 'reopened',
  in_progress: 'set in-progress',
  done: 'marked done',
  cancelled: 'cancelled',
};

export type StartResult =
  | { ok: true; ptyId?: number }
  | { ok: false; reason?: string; claimedBy?: string | null };

// task-c141c7765aa4 — the outcome `start()` now resolves with (never throws
// for a launch failure — the mint/no-window error is caught and folded into
// this same shape). `spawned` is true ONLY when a session actually came up
// (a ptyId was returned); a caller that needs to KNOW a real session exists
// before treating a claim as "in flight" (e.g. chain auto-continue) must gate
// on `spawned`, not just the absence of a thrown error. `released` tells the
// caller whether we already best-effort released an orphaned claim so it
// doesn't need to release it again.
export type StartOutcome =
  | { ok: true; spawned: true; ptyId?: number }
  | { ok: false; spawned: false; message: string; released: boolean };

export type TaskActions = {
  caps: (t: Task) => TaskSourceCapabilities | undefined;
  patch: (task: Task, patch: TaskUpdate, label?: string) => Promise<void>;
  remove: (task: Task) => Promise<void>;
  setStatus: (task: Task, status: TaskStatus) => Promise<void>;
  togglePin: (task: Task) => Promise<void>;
  setDue: (task: Task, value: string | null) => Promise<void>;
  /** Bulk patch a target list; partitions by capability and reports skips. */
  bulkPatch: (
    tasks: Task[],
    patch: TaskUpdate,
    verb: string,
  ) => Promise<void>;
  /** Bulk delete (the confirm dialog owns the gate UI; this is the apply). */
  bulkDelete: (tasks: Task[]) => Promise<void>;
  /** Source-native verb (release/reopen/complete/cancel). Surfaces {ok:false}. */
  sourceAction: (
    task: Task,
    action: 'release' | 'reopen' | 'complete' | 'cancel',
  ) => Promise<void>;
  /** Start = claim-then-launch for TypeBuild; run-now for local auto. Always
   *  resolves (never rejects) with a StartOutcome describing whether a
   *  session actually spawned; also reports the same status-line text `say()`
   *  already shows, so most callers can ignore the return value entirely. */
  start: (task: Task) => Promise<StartOutcome>;
};

// Apply a management patch to ONE task using the RIGHT transport for its
// source. Editable sources (local) take the updateTask path. Sources like
// TypeBuild reject updateTask (canEdit=false) — but their fields ARE editable
// through dedicated /chromeext sourceAction verbs, so route each field there:
//   status  → complete | cancel | reopen | claim   (the server has no generic
//             status patch — see electron/sources/typebuild.ts)
//   due_at  → the generic 'patch' verb ({due_at}; '' clears)
//   pinned  → unsupported (TypeBuild has no pin) → throw so the caller reports it
// Throws on failure so callers can report accurately instead of the old silent
// no-op that made the copilot think it succeeded (task-a54900e44182 report).
async function applyTaskPatch(
  task: Task,
  caps: TaskSourceCapabilities | undefined,
  p: TaskUpdate,
): Promise<void> {
  if (!caps || caps.canEdit) {
    await updateTask(task.id, p, task.source);
    return;
  }
  // Non-editable source: caps came from byId[task.source], so source is set.
  const source = task.source;
  if (!source) throw new Error(`can’t edit ${sourceLabel(task)} tasks`);
  if (p.status !== undefined) {
    const verb =
      p.status === 'done'
        ? 'complete'
        : p.status === 'cancelled'
          ? 'cancel'
          : p.status === 'pending'
            ? 'reopen'
            : p.status === 'in_progress'
              ? 'claim'
              : null;
    if (!verb) throw new Error(`can’t set status “${p.status}” on ${sourceLabel(task)} tasks`);
    await taskSourceAction(source, task.id, verb);
  }
  if (p.due_at !== undefined) {
    await taskSourceAction(source, task.id, 'patch', { due_at: p.due_at ?? '' });
  }
  if (p.pinned !== undefined) {
    throw new Error(`pinning isn’t supported for ${sourceLabel(task)} tasks`);
  }
}

export function useTaskActions(): TaskActions {
  const { dispatch } = useStore();
  const { byId } = useTaskSources();

  const capsFor = useCallback(
    (t: Task): TaskSourceCapabilities | undefined =>
      t.source ? byId[t.source]?.capabilities : undefined,
    [byId],
  );

  const say = useCallback(
    (msg: string) => dispatch({ type: 'setStatus', msg }),
    [dispatch],
  );

  const patch = useCallback(
    async (task: Task, p: TaskUpdate, label?: string) => {
      try {
        await applyTaskPatch(task, capsFor(task), p);
        if (label) say(`${label} · ${task.title}`);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const setStatus = useCallback(
    async (task: Task, status: TaskStatus) => {
      try {
        await applyTaskPatch(task, capsFor(task), { status });
        say(`${STATUS_VERBED[status]} · ${task.title}`);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const togglePin = useCallback(
    async (task: Task) => {
      try {
        await applyTaskPatch(task, capsFor(task), { pinned: !task.pinned });
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const setDue = useCallback(
    async (task: Task, value: string | null) => {
      try {
        await applyTaskPatch(task, capsFor(task), { due_at: value });
        say(value === null ? 'cleared due' : `due ${value} · ${task.title}`);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const remove = useCallback(
    async (task: Task) => {
      const caps = capsFor(task);
      if (caps && !caps.canDelete) {
        say(`can’t delete · ${sourceLabel(task)} tasks can’t be deleted here`);
        return;
      }
      try {
        await deleteTask(task.id, task.source);
        say('task deleted');
      } catch (e) {
        // fm-iwlc (S6) — a TypeBuild delete rejection (not_owner / 409
        // in_progress_elsewhere) arrives as a tagged reason; humanize it
        // distinctly rather than dumping the raw machine string.
        const reason = deleteReason(e);
        say(
          reason
            ? `couldn’t delete · ${formatSourceReason(reason)} · ${task.title}`
            : formatOpError('delete', e),
        );
      }
    },
    [capsFor, say],
  );

  const bulkPatch = useCallback(
    async (tasks: Task[], p: TaskUpdate, verb: string) => {
      if (tasks.length === 0) {
        say('no task targeted');
        return;
      }
      // Apply to EVERY task via applyTaskPatch — which uses the right transport
      // per source (updateTask for local; sourceAction verbs for TypeBuild), so
      // TypeBuild tasks are no longer silently skipped as "read-only".
      let ok = 0;
      let failed = 0;
      await Promise.all(
        tasks.map((t) =>
          applyTaskPatch(t, capsFor(t), p).then(
            () => {
              ok += 1;
            },
            () => {
              failed += 1;
            },
          ),
        ),
      );
      let msg = `${verb} · ${ok} task${ok === 1 ? '' : 's'}`;
      if (failed > 0) msg += ` · ${failed} failed`;
      say(msg);
    },
    [capsFor, say],
  );

  const bulkDelete = useCallback(
    async (tasks: Task[]) => {
      const doable: Task[] = [];
      let skipped = 0;
      for (const t of tasks) {
        const caps = capsFor(t);
        if (caps && !caps.canDelete) skipped++;
        else doable.push(t);
      }
      // fm-iwlc (S6) — track per-task delete failures so a rejected TypeBuild
      // delete (not_owner / in_progress_elsewhere) doesn't get silently
      // reported as "deleted". For a single-task delete (the detail/kebab path)
      // we surface the specific friendly reason; in a batch we just count them.
      const failures: Array<{ task: Task; reason: string | null; err: unknown }> = [];
      await Promise.all(
        doable.map((t) =>
          deleteTask(t.id, t.source).catch((err) => {
            failures.push({ task: t, reason: deleteReason(err), err });
          }),
        ),
      );
      const ok = doable.length - failures.length;
      // Single-task path: report the precise reason instead of a count.
      if (doable.length === 1 && failures.length === 1) {
        const { task, reason, err } = failures[0];
        say(
          reason
            ? `couldn’t delete · ${formatSourceReason(reason)} · ${task.title}`
            : formatOpError('delete', err),
        );
        return;
      }
      let msg = `deleted ${ok} task${ok === 1 ? '' : 's'}`;
      if (skipped > 0) msg += ` · ${skipped} skipped (read-only)`;
      if (failures.length > 0) msg += ` · ${failures.length} failed`;
      say(msg);
    },
    [capsFor, say],
  );

  const sourceAction = useCallback(
    async (task: Task, action: 'release' | 'reopen' | 'complete' | 'cancel') => {
      const source = task.source;
      if (!source) return;
      try {
        const res = (await taskSourceAction(source, task.id, action)) as
          | {
              ok?: boolean;
              reason?: string;
              claimedBy?: string | null;
              blockedBy?: string[];
            }
          | undefined;
        if (res && res.ok === false) {
          // fm-alfz (S1) — humanize the v2 reason vocabulary so the statusbar
          // shows friendly text rather than a machine reason.
          const friendly = formatSourceReason(res.reason, {
            claimedBy: res.claimedBy,
            blockedBy: res.blockedBy,
          });
          say(`couldn’t ${action} · ${friendly} · ${task.title}`);
          return;
        }
        const verbed: Record<typeof action, string> = {
          release: 'released',
          reopen: 'reopened',
          complete: 'completed',
          cancel: 'cancelled',
        };
        say(`${verbed[action]} · ${task.title}`);
      } catch (e) {
        say(formatOpError(action, e));
      }
    },
    [say],
  );

  const start = useCallback(
    async (task: Task): Promise<StartOutcome> => {
      try {
        // fm-b5at.5 — Start = claim-then-launch (TypeBuild) or run-now (local
        // auto). runTaskNow now returns a result object; for TypeBuild a
        // {ok:false} means a contested claim — surface it inline, not as a
        // throw (which is reserved for the mint gate / launch failing).
        const res = (await runTaskNow(task.id, task.source)) as StartResult | undefined;
        if (res && res.ok === false) {
          // fm-alfz (S1) — friendly reason text (claimed by X / not visible …).
          const message = formatSourceReason(res.reason ?? 'already claimed', {
            claimedBy: res.claimedBy,
          });
          say(`couldn’t start · ${message}`);
          // A contested claim was never ours to release — nothing to clean up.
          return { ok: false, spawned: false, message, released: false };
        }
        // task-3f0c6a6abe41 — a typebuild "start" is only genuinely SPAWNED
        // when runNow returns a real ptyId (spawnedOutcome enforces this). A
        // truthy-but-ptyId-less {ok:true} is exactly the phantom claim we must
        // never report as success, so treat it as a launch failure and fall
        // into the release-and-surface path below.
        const { ptyId, needsPtyThrow } = spawnedOutcome(task.source, res);
        if (needsPtyThrow) {
          throw new Error('[typebuild-launch:no-pty] start returned no session id');
        }
        // Past the guard, a session genuinely spawned (typebuild: a real pty
        // id; local: a resolved run).
        say(
          task.source === 'typebuild'
            ? 'starting TypeBuild session…'
            : 'running…',
        );
        return { ok: true, spawned: true, ptyId };
      } catch (e) {
        // task-c141c7765aa4 / task-3f0c6a6abe41 — runNow CLAIMS first, then
        // launches. The launch half can fail AFTER the claim (no hostable
        // window at the gesture-less auto-continue moment; a pty that never
        // spawned). afffda8 released the orphaned claim but SWALLOWED the real
        // reason and the UI kept lying "RUNNING". Now we: (1) extract the REAL
        // launch reason (typed [typebuild-launch:*] / [typebuild-mint:*]),
        // (2) LOG it token-free for diagnosis, (3) release the orphaned claim,
        // and (4) return the reason so the caller surfaces it on the row and
        // rolls the optimistic RUNNING state back — never a silent release.
        const reason = launchErrorReason(e) ?? mintErrorReason(e);
        const message = reason ?? formatOpError('start', e);
        console.warn(
          `[useTaskActions] start failed for ${task.source ?? 'local'} task: ${message}`,
        );
        let released = false;
        if (task.source === 'typebuild') {
          try {
            await taskSourceAction(task.source, task.id, 'release');
            released = true;
          } catch {
            // Best-effort: the release itself failing (offline, already
            // released, 404) must never mask the original launch error.
          }
        }
        say(
          released
            ? `auto-start failed: ${message} — start manually (claim released)`
            : `couldn’t start · ${message}`,
        );
        return { ok: false, spawned: false, message, released };
      }
    },
    [say],
  );

  return {
    caps: capsFor,
    patch,
    remove,
    setStatus,
    togglePin,
    setDue,
    bulkPatch,
    bulkDelete,
    sourceAction,
    start,
  };
}

function sourceLabel(task: Task): string {
  if (task.source === 'typebuild') return 'TypeBuild';
  if (!task.source || task.source === 'local') return 'local';
  return task.source;
}
