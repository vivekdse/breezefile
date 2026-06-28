// task-6255239581b2 — PURE "what needs my attention" computation over the
// project forest. Reframes the Projects grid around attention rather than raw
// recency: per project we tally the tasks wanting a human/agent (open/unclaimed,
// blocked, overdue, failed), roll those counts UP through sub-projects, and
// derive a ranking score + an "idle" flag (no attention AND no recent activity).
//
// Authored as plain ESM (with a co-located attention.d.mts) so `node --test
// tests/` can import it directly, matching tree.mjs / resolver.mjs.
//
// NON-PHI: like tree.mjs this only reads Task ROUTING/SCHEDULING fields
// (status, rawStatus, claimedBy, due_at, attempts, maxAttempts, created_at,
// updated_at). It NEVER touches a task title or body. Keep it that way.
//
// "Project" and "Task" are the camelCase renderer shapes from ../types.

/** @typedef {import('../types').Task} Task */
/** @typedef {import('./tree.d.mts').ProjectNode} ProjectNode */
/** @typedef {import('./attention.d.mts').ProjectAttention} ProjectAttention */

import { indexTree } from './tree.mjs';
import { CLAIM_TTL_MS, claimFreshness } from '../components/tasks/lifecycle.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_DAYS = 7;

// Ranking weights — blocked/failed/overdue are louder than a plain open task,
// so a project with one blocked item outranks one with a couple of fresh
// open items. These are signal weights, not exact priorities.
const W_BLOCKED = 5;
const W_FAILED = 5;
const W_STALLED = 5; // a stranded in_progress task is as loud as blocked/failed
const W_OVERDUE = 4;
const W_OPEN = 1;

/** Today as a 'YYYY-MM-DD' string (local). due_at is normalized day-only. */
export function todayKey(now = Date.now()) {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function isTerminal(task) {
  return task.status === 'done' || task.status === 'cancelled';
}

// task-80be320f06b3 — a STALLED in_progress task may sit unclaimed/lapsed only
// briefly before it's worth a human's eye, but we want a small grace so a row
// that just legitimately lost its claim (renewal in flight) isn't flagged the
// instant the TTL passes. The richer, audit-sourced staleness math (with the
// real "entered status at" time) lives in components/tasks/vitals.mjs; this
// list-level predicate uses only what a list row reliably carries — the claim
// timestamp (a REAL server stamp, unlike the now()-stamped updated_at) — so the
// project tally can flag stranded work without the per-task audit fetch.
const STALL_CLAIM_LAPSE_GRACE_MS = CLAIM_TTL_MS; // one extra TTL past lapse

/**
 * Is a list-row in_progress task stranded (no live worker)? We deliberately do
 * NOT use updated_at/created_at for "time in status" here — the TypeBuild list
 * endpoint now()-stamps both for every non-terminal row (see mapListRow), so
 * they're placeholders for exactly the in_progress rows we care about. Instead:
 *   - no claimedBy at all → a started-then-abandoned row: stranded.
 *   - claimedAt present and lapsed > CLAIM_TTL + grace → the holder is long gone.
 *   - claimedBy set but no claimedAt (list rows may omit it) → NOT flagged here
 *     (we can't prove it's lapsed; degrade to not-stranded so a genuinely-held
 *     task is never false-flagged — the detail pane, which has the audit, is the
 *     escalation path).
 * @param {Task} task
 * @param {number} now
 */
function isStalledRow(task, now) {
  if (task.status !== 'in_progress') return false;
  if (!task.claimedBy) return true;
  const fresh = claimFreshness(task.claimedAt ?? null, now);
  if (!fresh) return false; // claimed, no timestamp → can't disprove liveness
  return CLAIM_TTL_MS - fresh.ageMs < -STALL_CLAIM_LAPSE_GRACE_MS;
}

/** Per-task attention classification → which buckets (if any) it lands in. */
export function classify(task, today = todayKey(), now = Date.now()) {
  const terminal = isTerminal(task);
  const raw = (task.rawStatus ?? task.status ?? '').toLowerCase();

  // blocked: the row can't proceed (server raw 'blocked' or 'failed').
  const blocked = !terminal && (raw === 'blocked' || raw === 'failed');

  // failed (attempts exhausted): a retrying/failed automated run that has run
  // out of attempts wants a human. Guard on numeric attempts/maxAttempts.
  const exhausted =
    !terminal &&
    typeof task.attempts === 'number' &&
    typeof task.maxAttempts === 'number' &&
    task.maxAttempts > 0 &&
    task.attempts >= task.maxAttempts;
  const failed = exhausted || (!terminal && raw === 'failed');

  // overdue: past due_at and not terminal (mirrors TaskRow's overdue rule).
  const overdue = !terminal && !!task.due_at && task.due_at < today;

  // open/unclaimed: an actionable, un-started, un-claimed row wanting a pickup.
  // in_progress never counts; a row claimed by an agent run is being handled;
  // blocked/failed rows are surfaced via their own (louder) buckets, not "open".
  const open =
    !terminal &&
    task.status !== 'in_progress' &&
    !blocked &&
    !failed &&
    !task.claimedBy;

  // task-80be320f06b3 — stalled: an in_progress row with no LIVE worker. This is
  // the gap classify() used to leave open (in_progress never counted), so a
  // stranded task — crashed/quit worker, claim never released — was invisible to
  // attention. Now it counts. It's a distinct bucket (not folded into open/
  // blocked) so the UI can badge it and offer remediation specifically.
  const stalled = !terminal && isStalledRow(task, now);

  return { open, blocked, overdue, failed, stalled };
}

// task-18902d433658 — the SINGLE predicate that decides whether a task counts
// toward a project's "N need you" tally. The per-project count (bucket.attention
// at the call site below) and any UI that FILTERS a task list to "needs you"
// MUST both go through this, so the count and the filtered list can never
// disagree. A task needs attention iff it lands in any classify() bucket
// (open/blocked/overdue/failed).
export function needsAttention(task, today = todayKey(), now = Date.now()) {
  const c = classify(task, today, now);
  return c.open || c.blocked || c.overdue || c.failed || c.stalled;
}

/** Max(created_at, updated_at) for one task, ignoring non-finite values. */
function taskActivityMs(task) {
  let best = 0;
  if (Number.isFinite(task.created_at)) best = Math.max(best, task.created_at);
  if (Number.isFinite(task.updated_at)) best = Math.max(best, task.updated_at);
  return best;
}

function emptyOwn() {
  return {
    open: 0,
    blocked: 0,
    overdue: 0,
    failed: 0,
    stalled: 0,
    // distinct attention rows (any bucket) — drives `total`.
    attention: 0,
    // raw max activity ms seen (0 = none yet); -1 sentinel for "saw a real
    // (above-floor) timestamp at least once".
    activityMs: 0,
    sawRealActivity: false,
  };
}

function addOwn(into, from) {
  into.open += from.open;
  into.blocked += from.blocked;
  into.overdue += from.overdue;
  into.failed += from.failed;
  into.stalled += from.stalled;
  into.attention += from.attention;
  into.activityMs = Math.max(into.activityMs, from.activityMs);
  into.sawRealActivity = into.sawRealActivity || from.sawRealActivity;
}

/**
 * @param {ProjectNode[]} roots
 * @param {Task[]} tasks
 * @param {{ now?: number, idleAfterDays?: number, activityFloorMs?: number }} [opts]
 * @returns {Map<string, ProjectAttention>}
 */
export function computeProjectAttention(roots, tasks, opts = {}) {
  const now = opts.now ?? Date.now();
  const idleAfterDays = opts.idleAfterDays ?? DEFAULT_IDLE_DAYS;
  // Timestamps at/below the floor are placeholders (the TypeBuild list endpoint
  // stamps now() for every non-terminal row — see mapListRow). Treat them as
  // UNKNOWN activity so idle never hides a project on a fake "recent" stamp.
  const floor = opts.activityFloorMs ?? 0;
  const today = todayKey(now);
  const idleCutoff = now - idleAfterDays * DAY_MS;

  const index = indexTree(roots);

  /** @type {Map<string, ReturnType<typeof emptyOwn>>} */
  const own = new Map();
  for (const id of index.keys()) own.set(id, emptyOwn());

  // 1. Tally OWN attention from each task's projectId.
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const pid = t && t.projectId;
    if (!pid) continue;
    const bucket = own.get(pid);
    if (!bucket) continue; // task points at a project not in this forest
    const c = classify(t, today, now);
    if (c.open) bucket.open += 1;
    if (c.blocked) bucket.blocked += 1;
    if (c.overdue) bucket.overdue += 1;
    if (c.failed) bucket.failed += 1;
    if (c.stalled) bucket.stalled += 1;
    // Same OR as needsAttention() — kept inline here only because we've already
    // computed the buckets; needsAttention(t, today, now) is the exported
    // equivalent the UI filter uses, so the count and the filtered list stay
    // identical (stalled included).
    if (c.open || c.blocked || c.overdue || c.failed || c.stalled) bucket.attention += 1;
    // A timestamp STRICTLY OLDER than the floor (page-mount time) is a real
    // server stamp; anything at/after the floor is the now()-placeholder the
    // TypeBuild list endpoint writes (see mapListRow) → treated as unknown.
    const act = taskActivityMs(t);
    if (act > 0 && act < floor) {
      bucket.activityMs = Math.max(bucket.activityMs, act);
      bucket.sawRealActivity = true;
    }
  }

  // 2. Roll up descendant own → ancestor rolled (post-order).
  /** @type {Map<string, ReturnType<typeof emptyOwn>>} */
  const rolled = new Map();
  for (const id of index.keys()) rolled.set(id, emptyOwn());
  const rollNode = (node) => {
    const r = rolled.get(node.project.id);
    addOwn(r, own.get(node.project.id));
    for (const child of node.children) {
      rollNode(child);
      addOwn(r, rolled.get(child.project.id));
    }
  };
  for (const node of roots) rollNode(node);

  // 3. Materialize the public per-project attention.
  /** @type {Map<string, ProjectAttention>} */
  const out = new Map();
  for (const [id, r] of rolled) {
    const total = r.attention;
    const score =
      r.blocked * W_BLOCKED +
      r.failed * W_FAILED +
      r.stalled * W_STALLED +
      r.overdue * W_OVERDUE +
      r.open * W_OPEN;

    // last activity: only a real (above-floor) timestamp counts as known. If we
    // never saw one, activity is UNKNOWN → degrade to NOT idle.
    const lastActivityMs = r.sawRealActivity && r.activityMs > 0 ? r.activityMs : null;

    // idle = nothing needs attention AND (we know activity is stale). Unknown
    // activity is deliberately NOT idle so nothing important hides.
    const idle =
      total === 0 &&
      lastActivityMs != null &&
      lastActivityMs < idleCutoff;

    out.set(id, {
      open: r.open,
      blocked: r.blocked,
      overdue: r.overdue,
      failed: r.failed,
      stalled: r.stalled,
      total,
      score,
      lastActivityMs,
      idle,
    });
  }
  return out;
}

/** "3 open · 1 blocked · 1 overdue · 1 failed" — non-zero counts only. */
export function attentionSummary(a) {
  if (!a) return '';
  const parts = [];
  if (a.open > 0) parts.push(`${a.open} open`);
  if (a.blocked > 0) parts.push(`${a.blocked} blocked`);
  if (a.stalled > 0) parts.push(`${a.stalled} stalled`);
  if (a.overdue > 0) parts.push(`${a.overdue} overdue`);
  if (a.failed > 0) parts.push(`${a.failed} failed`);
  return parts.join(' · ');
}
