// task-80be320f06b3 — PURE "task vitals" helpers: time-in-current-status,
// last-activity, and the stalled-detection math behind a stranded in_progress
// task. Authored as plain ESM (with a co-located .d.mts for the TS app) so
// `node --test tests/` can import it directly, mirroring lifecycle.mjs /
// attention.mjs (Node here has no TS loader).
//
// WHY a separate module from lifecycle.mjs: lifecycle.mjs folds the WHOLE audit
// trail into a vertical timeline; this module answers two point questions about
// the CURRENT state — "how long has it been in this status" and "what was the
// very last thing that happened" — plus the staleness severity that colors the
// status dot and flags a stranded task. Both consume the same NON-PHI audit
// rows ({user, action, detail, at}) + routing-only task fields, never task text.
//
// DATA FACT we MUST respect (see attention.mjs / mapListRow): the TypeBuild list
// endpoint now()-stamps `updated_at`/`created_at` for every NON-terminal row, so
// those list fields are PLACEHOLDERS for exactly the in_progress tasks we care
// about. We therefore derive "entered current status at" and "last activity"
// from the AUDIT trail (real server-stamped event times), NEVER from the
// now()-stamped list timestamps.
//
// PHI invariant: inputs are timestamps + email principals + audit action verbs
// — never titles/bodies. Output carries only those NON-PHI primitives.

import { CLAIM_TTL_MS, relAge, claimFreshness, shortActor } from './lifecycle.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Audit `action` verbs that REPRESENT A STATUS TRANSITION (the "status lane").
// The newest of these is when the task ENTERED its current status. Mirrors the
// status-lane classification in lifecycle.mjs's ACTION_KIND, kept local so the
// two modules stay decoupled.
const STATUS_ACTIONS = new Set([
  'start',
  'in_progress',
  'complete',
  'completed',
  'done',
  'partial',
  'fail',
  'failed',
  'block',
  'blocked',
  'cancel',
  'cancelled',
  'reopen',
  'reopened',
  'create',
  'created',
]);

// Per-(mapped)status grace windows: how long a task may sit in a status before
// it reads as "overstaying". in_progress is the one that strands (a crashed
// worker), so it has the tightest grace. pending can legitimately wait. Terminal
// statuses never overstay. Values are signal thresholds, not hard SLAs.
const STATUS_GRACE_MS = {
  in_progress: 4 * HOUR, // a live agent run rarely holds in_progress this long
  pending: 14 * DAY,
};
// Past this multiple of the grace window we escalate amber → red.
const RED_MULTIPLE = 3;

const STATUS_VERB = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

function parseMs(at) {
  if (at == null || at === '') return NaN;
  return typeof at === 'number' ? at : Date.parse(at);
}

function isTerminalStatus(status) {
  return status === 'done' || status === 'cancelled';
}

/**
 * Newest audit event overall (actor + action + time) — the task's "last
 * activity". Returns null when there's nothing parseable. NON-PHI.
 * @param {Array<{user?:string, action?:string, detail?:string, at?:string}>|null|undefined} events
 * @returns {{ at: string, actor: string|null, action: string, ms: number } | null}
 */
export function lastActivity(events) {
  const list = Array.isArray(events) ? events : [];
  let best = null;
  let bestMs = -Infinity;
  for (const e of list) {
    const ms = parseMs(e?.at);
    if (Number.isNaN(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = {
        at: e.at,
        actor: e.user || null,
        action: (e.action ?? '').toLowerCase(),
        ms,
      };
    }
  }
  return best;
}

/**
 * When did the task ENTER its current status? Sourced from the AUDIT trail's
 * NEWEST status-lane event (never the now()-stamped list timestamp). Falls back
 * to `task.createdAtIso` (a real server stamp) when the audit carries no status
 * event — a freshly-created row's "entered at" IS its creation.
 *
 * @param {Array<{user?:string, action?:string, at?:string}>|null|undefined} events
 * @param {{ createdAtIso?: string|null }} [task]
 * @returns {{ at: string, ms: number, action: string|null, source: 'audit'|'created' } | null}
 */
export function enteredCurrentStatusAt(events, task = {}) {
  const list = Array.isArray(events) ? events : [];
  let best = null;
  let bestMs = -Infinity;
  for (const e of list) {
    const action = (e?.action ?? '').toLowerCase();
    if (!STATUS_ACTIONS.has(action)) continue;
    const ms = parseMs(e?.at);
    if (Number.isNaN(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = { at: e.at, ms, action, source: 'audit' };
    }
  }
  if (best) return best;
  // No status-lane audit → the creation timestamp is the entry into the current
  // (still original) status. Real server stamp, so safe to use.
  const createdMs = parseMs(task.createdAtIso);
  if (!Number.isNaN(createdMs)) {
    return { at: task.createdAtIso, ms: createdMs, action: 'created', source: 'created' };
  }
  return null;
}

/** Short absolute day for "(since Jun 22)". Local; NON-PHI. */
export function shortDay(at) {
  const ms = parseMs(at);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Is the task's claim LIVE right now? A live claim means a worker is (probably)
 * on it, so an in_progress task with a live claim is NOT stranded.
 *   - no claimedBy at all → not live (nobody holds it)
 *   - claimedAt present + within CLAIM_TTL → live
 *   - claimedAt present + past CLAIM_TTL → lapsed (not live)
 *   - claimedBy set but NO claimedAt (list rows carry no timestamp) → treat as
 *     live (we can't prove it's lapsed; degrade to NOT stranded so we never
 *     false-flag a genuinely-held task).
 * @param {{ claimedBy?: string|null, claimedAt?: string|number|null }} task
 * @param {number} [now]
 * @returns {boolean}
 */
export function hasLiveClaim(task = {}, now = Date.now()) {
  if (!task.claimedBy) return false;
  const fresh = claimFreshness(task.claimedAt ?? null, now);
  if (!fresh) return true; // claimed, but no timestamp to disprove liveness
  return !fresh.expired;
}

/**
 * Time-in-current-status vitals. Derives the elapsed time from the audit-sourced
 * "entered status at" ms (NEVER the now()-stamped list field) and grades it
 * against the per-status grace window — but only escalates an in_progress row
 * when there's NO live claim (a live worker explains a long in_progress).
 *
 * @param {{ status?: string, claimedBy?: string|null, claimedAt?: string|number|null }} task
 * @param {number|null} enteredAtMs ms epoch the task entered its current status
 *        (from enteredCurrentStatusAt) — null when unknown.
 * @param {number} [now]
 * @returns {{
 *   ms: number|null, label: string, since: string, sinceDay: string,
 *   severity: 'ok'|'warn'|'over', status: string,
 * }}
 */
export function timeInStatus(task = {}, enteredAtMs, now = Date.now()) {
  const status = task.status ?? '';
  const verb = STATUS_VERB[status] ?? status ?? 'Status';
  if (enteredAtMs == null || !Number.isFinite(enteredAtMs)) {
    return { ms: null, label: verb, since: '', sinceDay: '', severity: 'ok', status };
  }
  const ms = Math.max(0, now - enteredAtMs);
  const dur = compactDuration(ms);
  const sinceDay = shortDay(enteredAtMs);
  let severity = 'ok';
  if (!isTerminalStatus(status)) {
    const grace = STATUS_GRACE_MS[status];
    if (typeof grace === 'number') {
      // A live claim explains a long in_progress → don't escalate.
      const excused = status === 'in_progress' && hasLiveClaim(task, now);
      if (!excused && ms > grace) severity = ms > grace * RED_MULTIPLE ? 'over' : 'warn';
    }
  }
  return {
    ms,
    label: `${verb} · ${dur}`,
    since: relAge(ms),
    sinceDay,
    severity,
    status,
  };
}

/**
 * Compact duration for a "for 6d" / "for 5h" tooltip+line. Coarser than relAge
 * (no "ago" suffix, and minutes for short spans). NON-PHI.
 * @param {number} ms
 * @returns {string}
 */
export function compactDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MIN);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(ms / DAY)}d`;
}

/**
 * The single STALLED predicate (detail-pane variant, with audit + claim data):
 * an in_progress task with NO live worker that has overstayed the grace window.
 * The list-level equivalent lives in attention.mjs's classify() so the count and
 * filtered list route through one place; this richer form is what the detail
 * banner uses (it has the audit-sourced entered-status time).
 *
 * stalled ⇔ status==='in_progress'
 *            AND NOT hasLiveClaim (no claimedBy, or claim lapsed past TTL)
 *            AND time-in-status > grace window (when we know it; when the entry
 *                time is unknown we still flag an UNCLAIMED in_progress, since a
 *                started-then-abandoned row is the core stranded case).
 *
 * @param {{ status?: string, claimedBy?: string|null, claimedAt?: string|number|null }} task
 * @param {number|null} enteredAtMs from enteredCurrentStatusAt (null = unknown)
 * @param {number} [now]
 * @returns {boolean}
 */
export function isStalled(task = {}, enteredAtMs, now = Date.now()) {
  if ((task.status ?? '') !== 'in_progress') return false;
  if (hasLiveClaim(task, now)) return false;
  const grace = STATUS_GRACE_MS.in_progress;
  if (enteredAtMs == null || !Number.isFinite(enteredAtMs)) {
    // No entry time: only flag when nobody holds it at all (a claim that merely
    // lacks a timestamp was already excused by hasLiveClaim above).
    return !task.claimedBy;
  }
  return now - enteredAtMs > grace;
}

/**
 * Health accent for the status dot when something's off: 'stalled' (no worker,
 * overstayed) outranks 'lapsed' (claim past TTL but maybe not yet overstayed).
 * Returns null when healthy. Drives a subtle ring/tint on TaskStatusDot.
 * @param {{ status?: string, claimedBy?: string|null, claimedAt?: string|number|null }} task
 * @param {number|null} enteredAtMs
 * @param {number} [now]
 * @returns {'stalled'|'lapsed'|null}
 */
export function statusDotHealth(task = {}, enteredAtMs, now = Date.now()) {
  if (isStalled(task, enteredAtMs, now)) return 'stalled';
  const fresh = claimFreshness(task.claimedAt ?? null, now);
  if (fresh && fresh.expired) return 'lapsed';
  return null;
}

/**
 * One-line "Last activity" summary: "6d ago — released by vivek". Built from the
 * newest audit event (actor + action verb + time, all NON-PHI). Returns '' when
 * there's no activity to describe.
 * @param {ReturnType<typeof lastActivity>} la result of lastActivity(events)
 * @param {number} [now]
 * @returns {string}
 */
export function lastActivitySummary(la, now = Date.now()) {
  if (!la) return '';
  const verb = ACTIVITY_VERB[la.action] || titleCase(la.action) || 'updated';
  const who = la.actor ? ` — ${verb} by ${shortActor(la.actor)}` : ` — ${verb}`;
  return `${relAge(now - la.ms)}${who}`;
}

const ACTIVITY_VERB = {
  create: 'created',
  created: 'created',
  claim: 'claimed',
  claimed: 'claimed',
  reclaim: 're-claimed',
  renew: 'renewed',
  renewed: 'renewed',
  release: 'released',
  released: 'released',
  start: 'started',
  in_progress: 'started',
  complete: 'completed',
  completed: 'completed',
  done: 'completed',
  partial: 'set partial',
  fail: 'failed',
  failed: 'failed',
  block: 'blocked',
  blocked: 'blocked',
  cancel: 'cancelled',
  cancelled: 'cancelled',
  reopen: 'reopened',
  reopened: 'reopened',
};

function titleCase(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

export { CLAIM_TTL_MS };
