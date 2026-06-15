// fm-dhc — task client hook. Wraps the task IPC, listens for `tasks:changed`
// broadcasts, and re-pulls. Each consumer maintains its own filter slice;
// the broadcast is global so a single change notifies every active hook.

import { useEffect, useRef, useState } from 'react';
import { fm } from './bridge';
import { humanizeError } from './errorMessages';
import type { RemoteSchedule, Task, TaskAuditEvent, TaskCreate, TaskFilter, TaskRun, TaskRunWithTitle, TaskSourceInfo, TaskUpdate, TaskUser } from './types';

// ─── optimistic pending-patch overlay (fm-kmhq, Phase A3) ──────────────────
// A small renderer-side overlay that holds the fields of a just-succeeded
// mutation until the fetched list actually reflects them. Without it, a
// mutation routed through a source whose broadcast lags (notably the TypeBuild
// 30s poll) can flip a row back to its old state for a beat. Entries are
// recorded ONLY after the IPC resolves (see updateTask) so a failed mutation
// never shows phantom state, and they drop themselves once the server agrees
// or after a 10s TTL (guards against a stale optimistic value outliving a
// genuine server change the poll later carries).
type PendingEntry = { patch: Partial<Task>; ts: number };
const PENDING_TTL_MS = 10_000;
const pendingPatches = new Map<string, PendingEntry>();
const pendingListeners = new Set<() => void>();

function pendingKey(source: string | undefined, id: string): string {
  return `${source ?? 'local'}:${id}`;
}

function recordPendingPatch(
  source: string | undefined,
  id: string,
  patch: Partial<Task>,
): void {
  pendingPatches.set(pendingKey(source, id), { patch, ts: Date.now() });
  for (const cb of pendingListeners) {
    try {
      cb();
    } catch {
      /* a listener throwing must not break the others */
    }
  }
}

// True when `row` already reflects every field in `patch` — i.e. the server
// has caught up and the overlay entry can be dropped.
function rowSatisfiesPatch(row: Task, patch: Partial<Task>): boolean {
  return (Object.keys(patch) as (keyof Task)[]).every(
    (k) => row[k] === patch[k],
  );
}

// Apply live overlay entries over a fetched list, dropping any entry the list
// already satisfies or that has aged past the TTL. Mutates the module map
// (prune) and returns a new array with patches folded in.
function applyPendingPatches(list: Task[]): Task[] {
  if (pendingPatches.size === 0) return list;
  const now = Date.now();
  // Index the fetched rows so we can both prune satisfied/expired entries and
  // overlay the survivors in one pass.
  const byKey = new Map<string, Task>();
  for (const t of list) byKey.set(pendingKey(t.source, t.id), t);

  for (const [key, entry] of pendingPatches) {
    const row = byKey.get(key);
    // Drop when the server row already reflects the patch, when the row is
    // gone (deleted), or when the entry has aged past its TTL.
    if (
      now - entry.ts > PENDING_TTL_MS ||
      !row ||
      rowSatisfiesPatch(row, entry.patch)
    ) {
      pendingPatches.delete(key);
    }
  }
  if (pendingPatches.size === 0) return list;

  return list.map((t) => {
    const entry = pendingPatches.get(pendingKey(t.source, t.id));
    return entry ? { ...t, ...entry.patch } : t;
  });
}

export function useTasks(filter: TaskFilter = {}): {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stringify the filter into a stable key so we re-fetch when it changes
  // semantically, not when the parent passes a fresh object identity.
  const filterKey = JSON.stringify(filter);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // Keep the last fetched list so a pending-patch notification (which arrives
  // without a re-fetch) can re-apply the overlay over the same rows.
  const lastListRef = useRef<Task[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        const list = await fm.tasksList(filterRef.current);
        if (!cancelled) {
          lastListRef.current = list;
          setTasks(applyPendingPatches(list));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(humanizeError(e).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const unsub = fm.onTasksChanged(load);
    // Re-apply the overlay when a fresh patch is recorded (no re-fetch yet).
    const onPending = () => {
      if (!cancelled) setTasks(applyPendingPatches(lastListRef.current));
    };
    pendingListeners.add(onPending);
    return () => {
      cancelled = true;
      unsub();
      pendingListeners.delete(onPending);
    };
  }, [filterKey]);

  return {
    tasks,
    loading,
    error,
    refresh: async () => {
      const list = await fm.tasksList(filterRef.current);
      lastListRef.current = list;
      setTasks(applyPendingPatches(list));
    },
  };
}

// breezed P4 — `source` ('local' | <host>) routes the mutation to the
// owning machine. Optional + defaulting to local keeps every existing
// caller working unchanged.
export async function createTask(
  input: TaskCreate,
  source?: string,
): Promise<Task> {
  return fm.tasksCreate(input, source);
}
export async function updateTask(
  id: string,
  patch: TaskUpdate,
  source?: string,
): Promise<Task> {
  const result = await fm.tasksUpdate(id, patch, source);
  // fm-kmhq (Phase A3) — record an optimistic overlay so the row reflects the
  // patch on the next render even if the backing source's broadcast lags (the
  // TypeBuild source's 30s poll, in particular, can otherwise resurrect stale
  // state for a beat). Recorded AFTER the IPC resolves — a failed mutation
  // throws above and never reaches here, so we never show phantom state.
  recordPendingPatch(source, id, patch as Partial<Task>);
  return result;
}
export async function deleteTask(id: string, source?: string): Promise<void> {
  return fm.tasksDelete(id, source);
}
export async function getTask(id: string, source?: string): Promise<Task | null> {
  return fm.tasksGet(id, source);
}

// fm-b5at.1 — invoke a source-native verb (claim/release/reopen, ...) on
// a task. Sources without the matching capability throw 'unsupported'.
export async function taskSourceAction(
  source: string,
  taskId: string,
  action: string,
  payload?: unknown,
): Promise<unknown> {
  return fm.tasksSourceAction(source, taskId, action, payload);
}

// fm-j7w0 (S4) — the TypeBuild user registry for the assignee picker. Returns
// [] when signed out (the picker degrades to "Unassigned" only). Non-PHI.
export async function listTypebuildUsers(): Promise<TaskUser[]> {
  return fm.typebuild.listUsers();
}

// fm-k6wz (S7) — per-task audit history for the detail History section. Memory
// only — callers hold the rows in component state and never persist them.
export async function getTypebuildAudit(
  taskId: string,
  limit = 20,
): Promise<TaskAuditEvent[]> {
  return fm.typebuild.audit(taskId, limit);
}

// fm-b5at.8 — PHI-free schedule overlay for remote-source tasks. The overlay
// stores a local cron (opaque ids + cron only) so a time-gated remote task can
// fire on the local scheduler. setOverlaySchedule throws on an invalid cron
// (the main-process validator); callers surface the message inline.
export async function setOverlaySchedule(
  source: string,
  taskId: string,
  cron: string,
): Promise<RemoteSchedule> {
  return fm.tasksOverlaySet(source, taskId, cron);
}

export async function clearOverlaySchedule(
  source: string,
  taskId: string,
): Promise<void> {
  return fm.tasksOverlayClear(source, taskId);
}

// All active overlay schedules, keyed "<source>:<task>" for cheap row lookup.
// Re-pulls on tasks:changed (overlay writes broadcast it). Returns a map so a
// row can render its ⏰ pill without scanning a list.
export function useOverlaySchedules(): Record<string, RemoteSchedule> {
  const [byKey, setByKey] = useState<Record<string, RemoteSchedule>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await fm.tasksOverlayList();
        if (cancelled) return;
        const map: Record<string, RemoteSchedule> = {};
        for (const s of list) map[`${s.sourceId}:${s.taskId}`] = s;
        setByKey(map);
      } catch {
        /* keep the last-known set */
      }
    };
    void load();
    const unsub = fm.onTasksChanged(() => void load());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return byKey;
}

// fm-b5at.1 — registered TaskSources + their capabilities. Re-pulls on
// sources:changed so a source connecting/disconnecting (TypeBuild) keeps
// the capability map fresh. The local source is always present.
const LOCAL_SOURCE: TaskSourceInfo = {
  id: 'local',
  label: 'Local',
  capabilities: {
    canSchedule: true,
    canClaim: false,
    canEdit: true,
    canDelete: true,
    // fm-r8vj (S5 plumbing) — local tasks are creatable.
    canCreate: true,
    phiSensitive: false,
    hasFolder: true,
  },
};

export function useTaskSources(): {
  sources: TaskSourceInfo[];
  byId: Record<string, TaskSourceInfo>;
} {
  const [sources, setSources] = useState<TaskSourceInfo[]>([LOCAL_SOURCE]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await fm.tasksSources();
        if (!cancelled && list.length) setSources(list);
      } catch {
        /* keep the last-known set */
      }
    };
    void load();
    const unsub = fm.onSourcesChanged(() => void load());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  const byId: Record<string, TaskSourceInfo> = {};
  for (const s of sources) byId[s.id] = s;
  return { sources, byId };
}

// fm-b5at.5 — TypeBuild Start readiness. A TypeBuild task is startable only
// when the user is signed in AND the local prerequisites (Claude Code +
// Chrome) are present. We read auth state + detect checks once, refresh the
// detect checks on auth change (signing in is usually when onboarding
// completes), and expose a single `ready` flag the Start gate consumes.
// PHI-free: only booleans cross the wire.
// fm-v0rc (Phase B5): also expose `email` — the signed-in principal. Release
// (and other claimed-by-me gates) compare a row's claimedBy against it.
// Lightweight auth-only subscription: just signed-in state + email, with no
// prerequisite (claude/chrome) detection. Used by the sidebar sign-in
// indicators where the shell-spawning detect checks aren't wanted.
export function useTypebuildAuth(): { signedIn: boolean; email: string | null } {
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fm.typebuild
      .authState()
      .then((s) => {
        if (!cancelled) {
          setSignedIn(!!s.signedIn);
          setEmail(s.email ?? null);
        }
      })
      .catch(() => {});
    const off = fm.typebuild.onAuthChanged((s) => {
      if (cancelled) return;
      setSignedIn(!!s.signedIn);
      setEmail(s.email ?? null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return { signedIn, email };
}

export function useTypebuildReadiness(): {
  signedIn: boolean;
  claudeOk: boolean;
  chromeOk: boolean;
  email: string | null;
  ready: boolean;
} {
  const [signedIn, setSignedIn] = useState(false);
  const [claudeOk, setClaudeOk] = useState(false);
  const [chromeOk, setChromeOk] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadChecks = async () => {
      try {
        const checks = await fm.typebuild.detectChecks();
        if (!cancelled) {
          setClaudeOk(!!checks.claude.ok);
          setChromeOk(!!checks.chrome.ok);
        }
      } catch {
        /* keep last-known; detect is best-effort */
      }
    };
    void fm.typebuild
      .authState()
      .then((s) => {
        if (!cancelled) {
          setSignedIn(!!s.signedIn);
          setEmail(s.email ?? null);
        }
      })
      .catch(() => {});
    void loadChecks();
    const off = fm.typebuild.onAuthChanged((s) => {
      if (cancelled) return;
      setSignedIn(!!s.signedIn);
      setEmail(s.email ?? null);
      // Re-run detect on sign-in — the user likely just finished onboarding.
      if (s.signedIn) void loadChecks();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return {
    signedIn,
    claudeOk,
    chromeOk,
    email,
    ready: signedIn && claudeOk && chromeOk,
  };
}

// fm-zf3m — runs API + hooks for the renderer.
// fm-v0rc (Phase B4): return the source's run result instead of void. The
// local source returns { run, result }; TypeBuild's Start returns a
// { ok, ptyId } / { ok:false, reason, claimedBy } union so the Start handler
// can surface "couldn't start · claimed by X" inline. Callers that don't care
// can ignore the resolved value.
export async function runTaskNow(id: string, source?: string): Promise<unknown> {
  return fm.tasksRunNow(id, source);
}
// fm-femh — run a task against an explicit cwd (the active folder tab).
// Used by the Run-task modal so folder-agnostic tasks can be triggered
// in any folder, and folder-anchored tasks can be reused elsewhere.
export async function runTaskNowAt(id: string, cwd: string): Promise<void> {
  await fm.tasksRunNowAt(id, cwd);
}
// fm-femh — cancel an in-flight agent run. Returns true if a run was
// signalled, false if it had already finished by the time we asked.
export async function cancelTaskRun(runId: string): Promise<boolean> {
  return fm.tasksCancelRun(runId);
}
export async function listTaskRuns(id: string, limit = 50): Promise<TaskRun[]> {
  return fm.tasksRunsList(id, limit);
}

/** Subscribe to a task's last run; updates whenever the scheduler or
 *  manual run-now writes a new run row for that task. Returns null
 *  when the task has never run. */
export function useLastRun(taskId: string | null): TaskRun | null {
  const [run, setRun] = useState<TaskRun | null>(null);
  useEffect(() => {
    if (!taskId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fm.tasksLastRun(taskId);
        if (!cancelled) setRun(r);
      } catch {
        if (!cancelled) setRun(null);
      }
    };
    void load();
    const unsub = fm.onTaskRunsChanged((changedId) => {
      if (changedId === taskId) void load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [taskId]);
  return run;
}

/** Hook for the cross-task Runs view. Returns recent runs across all
 *  tasks (joined with task title + folder), refreshed on any
 *  task-runs:changed event. */
export function useAllRuns(limit = 200): TaskRunWithTitle[] {
  const [runs, setRuns] = useState<TaskRunWithTitle[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fm.tasksRunsListAll(limit);
        if (!cancelled) setRuns(r);
      } catch {
        if (!cancelled) setRuns([]);
      }
    };
    void load();
    const unsub = fm.onTaskRunsChanged(() => void load());
    return () => {
      cancelled = true;
      unsub();
    };
  }, [limit]);
  return runs;
}

/** Hook for per-task run counts (used to render "N runs" pills on
 *  TasksPage rows). One IPC call covers every task. */
export function useRunCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const c = await fm.tasksRunsCountByTask();
        if (!cancelled) setCounts(c);
      } catch {
        if (!cancelled) setCounts({});
      }
    };
    void load();
    const unsub = fm.onTaskRunsChanged(() => void load());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return counts;
}

/** Hook variant for a task's full run list. Re-pulls on any
 *  task-runs:changed event for that task. */
export function useTaskRuns(taskId: string | null, limit = 50): TaskRun[] {
  const [runs, setRuns] = useState<TaskRun[]>([]);
  useEffect(() => {
    if (!taskId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fm.tasksRunsList(taskId, limit);
        if (!cancelled) setRuns(r);
      } catch {
        if (!cancelled) setRuns([]);
      }
    };
    void load();
    const unsub = fm.onTaskRunsChanged((changedId) => {
      if (changedId === taskId) void load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [taskId, limit]);
  return runs;
}

// fm-adc — assemble the templated first-message that gets pre-typed into
// the agent's input box. v1 uses simple field substitution rather than a
// full templating engine: the field set is small, escaping is a
// non-issue (this is interactive prompt text, not a shell command), and
// we want zero new dependencies on the renderer side. The `userTemplate`
// parameter is a stub for a future Settings hook (fm-fc0 era) — passing
// undefined falls back to the built-in default.
export function buildContextPrompt(task: Task, userTemplate?: string): string {
  if (userTemplate && userTemplate.trim()) {
    return renderTemplate(userTemplate, task);
  }
  const lines: string[] = [];
  lines.push(`I am working on Breeze task: ${task.title}`);
  lines.push('');
  lines.push(`  Folder: ${task.folder}`);
  if (task.due_at) lines.push(`  Due: ${task.due_at}`);
  if (task.notes && task.notes.trim()) {
    // Inline single-line notes; for multi-line, keep as a block under a label
    // so the agent doesn't read the body as a continuation of the bullet.
    const notes = task.notes.trim();
    if (notes.includes('\n')) {
      lines.push('  Notes:');
      for (const ln of notes.split('\n')) lines.push(`    ${ln}`);
    } else {
      lines.push(`  Notes: ${notes}`);
    }
  }
  lines.push('');
  lines.push('You can update the task with `breeze task <subcmd>`.');
  return lines.join('\n');
}

function renderTemplate(tpl: string, task: Task): string {
  // Minimal {{field}} + {{#if field}}...{{/if}} substitution. Anything
  // beyond this should justify a real engine.
  const fields: Record<string, string | null> = {
    id: task.id,
    title: task.title,
    folder: task.folder,
    status: task.status,
    notes: task.notes,
    due_at: task.due_at,
    start_at: task.start_at,
  };
  let out = tpl.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, name: string, body: string) => {
      const v = fields[name];
      return v && String(v).trim() ? body : '';
    },
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = fields[name];
    return v == null ? '' : String(v);
  });
  return out;
}

/** Today's date as 'YYYY-MM-DD' in local time (matches what the DB stores). */
export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add days to a 'YYYY-MM-DD' date, return new 'YYYY-MM-DD'. */
export function shiftISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return todayISOFromDate(date);
}

/** Parse a free-form date string into ISO ('YYYY-MM-DD') or null (empty input).
 *  Returns `undefined` when the input can't be interpreted. Accepts:
 *    today / tod / t            tomorrow / tom / tmrw
 *    +Nd / +Nw / Nd / Nw        eow (Friday this week) / eom (last day this month)
 *    mon / tue / ... / sun      (next occurrence; today's weekday → 7d out)
 *    YYYY-MM-DD                 (passed through)
 *  Designed for the task dialog so users can type "tom" or "+3d" instead
 *  of clicking a date picker. */
export function parseDateInput(
  input: string,
  today: string = todayISO(),
): string | null | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === 'today' || s === 'tod' || s === 't') return today;
  if (s === 'tomorrow' || s === 'tom' || s === 'tmrw') return shiftISO(today, 1);
  if (s === 'yesterday' || s === 'yes' || s === 'y') return shiftISO(today, -1);
  const todayDow = new Date(today + 'T00:00:00').getDay(); // 0=Sun..6=Sat
  if (s === 'eow') return shiftISO(today, ((5 - todayDow + 7) % 7) || 7);
  if (s === 'eom') {
    const [y, m] = today.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  }
  const rel = /^([+-]?)(\d+)\s*([dw])$/.exec(s);
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const n = Number(rel[2]) * (rel[3] === 'w' ? 7 : 1);
    return shiftISO(today, sign * n);
  }
  const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const idx = dow.indexOf(s.slice(0, 3));
  if (idx >= 0) {
    const delta = ((idx - todayDow + 7) % 7) || 7;
    return shiftISO(today, delta);
  }
  return undefined;
}

function todayISOFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// fm-a9j — due-date display helpers, hoisted out of Sidebar.tsx so the
// task-mode shell uses the same vocabulary. One source of truth means a
// task that says "tomorrow" in the sidebar reads "tomorrow" in the header.

export type DueTone = 'overdue' | 'today' | 'soon' | 'future' | 'none';

export function dueTone(due: string | null, today: string = todayISO()): DueTone {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  // "soon" = within the next 3 days
  const diffDays = daysBetween(today, due);
  if (diffDays <= 3) return 'soon';
  return 'future';
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

export function formatDueLabel(due: string, today: string = todayISO()): string {
  if (due < today) {
    const days = daysBetween(due, today);
    return days === 1 ? '1d overdue' : `${days}d overdue`;
  }
  if (due === today) return 'today';
  const days = daysBetween(today, due);
  if (days === 1) return 'tomorrow';
  if (days < 7) {
    // Day-of-week label for proximate dates feels more human than a date.
    const [y, m, d] = due.split('-').map(Number);
    const dow = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
    return dow.toLowerCase();
  }
  // 'YYYY-MM-DD' → 'Apr 30' for distant dates.
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
