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
import type { Task, TaskSourceCapabilities, TaskStatus, TaskUpdate } from '../../types';

// fm-b5at.9 — map a thrown TypeBuild MCP-token mint failure to the bead's
// three exact in-app messages (the typed code rides in the error message as
// "[typebuild-mint:<code>]"; IPC strips custom Error props). Returns null for
// anything that isn't a mint error so the caller falls back to its formatter.
const MINT_MESSAGES: Record<string, string> = {
  'signed-out': 'Please sign in again',
  unreachable: "Can't reach TypeBuild right now",
  'access-denied': 'Your access has changed, contact your admin',
};
function mintErrorMessage(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-mint:([a-z-]+)\]/.exec(raw);
  if (!m) return null;
  return MINT_MESSAGES[m[1]] ?? null;
}

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
  /** Start = claim-then-launch for TypeBuild; run-now for local auto. */
  start: (task: Task) => Promise<void>;
};

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
      const caps = capsFor(task);
      if (caps && !caps.canEdit) {
        say(`can’t edit · ${sourceLabel(task)} tasks are read-only here`);
        return;
      }
      try {
        await updateTask(task.id, p, task.source);
        if (label) say(`${label} · ${task.title}`);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const setStatus = useCallback(
    async (task: Task, status: TaskStatus) => {
      const caps = capsFor(task);
      if (caps && !caps.canEdit) {
        say(`can’t change status · ${sourceLabel(task)} tasks are read-only here`);
        return;
      }
      try {
        await updateTask(task.id, { status }, task.source);
        say(`${STATUS_VERBED[status]} · ${task.title}`);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const togglePin = useCallback(
    async (task: Task) => {
      const caps = capsFor(task);
      if (caps && !caps.canEdit) {
        say(`can’t pin · ${sourceLabel(task)} tasks are read-only here`);
        return;
      }
      try {
        await updateTask(task.id, { pinned: !task.pinned }, task.source);
      } catch (e) {
        say(formatOpError('update', e));
      }
    },
    [capsFor, say],
  );

  const setDue = useCallback(
    async (task: Task, value: string | null) => {
      const caps = capsFor(task);
      if (caps && !caps.canEdit) {
        say(`can’t set due · ${sourceLabel(task)} tasks are read-only here`);
        return;
      }
      try {
        await updateTask(task.id, { due_at: value }, task.source);
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
      const doable: Task[] = [];
      let skipped = 0;
      for (const t of tasks) {
        const caps = capsFor(t);
        if (caps && !caps.canEdit) skipped++;
        else doable.push(t);
      }
      await Promise.all(
        doable.map((t) =>
          updateTask(t.id, p, t.source).catch(() => {
            /* a single failure shouldn't sink the batch; counted as done
               optimistically — the poll reconciles. */
          }),
        ),
      );
      const n = doable.length;
      let msg = `${verb} · ${n} task${n === 1 ? '' : 's'}`;
      if (skipped > 0) msg += ` · ${skipped} skipped (read-only)`;
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
    async (task: Task) => {
      try {
        // fm-b5at.5 — Start = claim-then-launch (TypeBuild) or run-now (local
        // auto). runTaskNow now returns a result object; for TypeBuild a
        // {ok:false} means a contested claim — surface it inline, not as a
        // throw (which is reserved for the mint gate failing).
        const res = (await runTaskNow(task.id, task.source)) as StartResult | undefined;
        if (res && res.ok === false) {
          // fm-alfz (S1) — friendly reason text (claimed by X / not visible …).
          say(
            `couldn’t start · ${formatSourceReason(res.reason ?? 'already claimed', {
              claimedBy: res.claimedBy,
            })}`,
          );
          return;
        }
        say(
          task.source === 'typebuild'
            ? 'starting TypeBuild session…'
            : 'running…',
        );
      } catch (e) {
        // The MCP-token mint GATES the spawn: on failure NO terminal opens and
        // runNow throws a typed error. Map the three codes to exact messages.
        const msg = mintErrorMessage(e);
        say(msg ?? formatOpError('start', e));
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
