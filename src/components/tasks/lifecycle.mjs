// task-b8306d2b85c2 — PURE lifecycle/timeline helpers for the task-detail UI.
//
// Authored as plain ESM (with a co-located .d.mts for the TS app) so
// `node --test tests/` can import it directly — Node here has no TS loader,
// mirroring the src/components/tasks/sections.mjs pattern.
//
// Two jobs:
//   1. claimFreshness(claimedAt, now) — turn a claim timestamp into a relative
//      age + a near-expiry flag against the 2h claim TTL. The detail panel,
//      drawer, and the TaskRow ◆ tooltip all describe a claim the same way.
//   2. buildTimeline(events, task) — fold the per-task AUDIT trail (the only
//      place the server persists create/claim/status history) into an ordered
//      vertical-timeline model: Created → Claimed → status transitions. Pure
//      and content-free: it consumes audit {user, action, detail, at} rows
//      (NON-PHI by design) + the routing-only task fields, never task text.
//
// PHI invariant: inputs are timestamps + email principals + audit action verbs
// — never titles/bodies. Output carries only those NON-PHI primitives.

// The server's claim hold lives 2 hours (spec §1.5 — re-claim by the holder
// renews it). We warn when a claim is within this window of lapsing.
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const NEAR_EXPIRY_MS = 20 * 60 * 1000; // flag the last 20 min of the hold

/**
 * Coarse relative time from an epoch-ms delta. "just now" / "12m ago" /
 * "1h 50m ago" / "3d ago". Returns '' for a non-finite input.
 * @param {number} ms milliseconds in the PAST (now - then)
 * @returns {string}
 */
export function relAge(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Describe a claim's freshness against the 2h TTL.
 * @param {string|number|null|undefined} claimedAt ISO string or epoch
 * @param {number} [now] epoch-ms (injectable for tests)
 * @returns {{ relative: string, expiresSoon: boolean, expired: boolean,
 *            ageMs: number } | null} null when there's no parseable timestamp
 */
export function claimFreshness(claimedAt, now = Date.now()) {
  if (claimedAt == null || claimedAt === '') return null;
  const t = typeof claimedAt === 'number' ? claimedAt : Date.parse(claimedAt);
  if (Number.isNaN(t)) return null;
  const ageMs = now - t;
  const remaining = CLAIM_TTL_MS - ageMs;
  return {
    relative: relAge(ageMs),
    ageMs,
    expired: remaining <= 0,
    expiresSoon: remaining > 0 && remaining <= NEAR_EXPIRY_MS,
  };
}

/**
 * One-line claim summary for a row tooltip / detail line.
 *   "claimed by you 12m ago" · "claimed by alice 1h 50m ago (claim expires soon)"
 * @param {string|null} claimedBy principal/email holding the claim
 * @param {boolean} claimedByMe whether that's the signed-in user
 * @param {string|number|null|undefined} claimedAt
 * @param {number} [now]
 * @returns {string}
 */
export function claimSummary(claimedBy, claimedByMe, claimedAt, now = Date.now()) {
  const who = claimedByMe ? 'you' : claimedBy || 'someone';
  const fresh = claimFreshness(claimedAt, now);
  if (!fresh) return `claimed by ${who}`;
  let tail = '';
  if (fresh.expired) tail = ' (claim lapsed)';
  else if (fresh.expiresSoon) tail = ' (claim expires soon)';
  return `claimed by ${who} ${fresh.relative}${tail}`;
}

// Audit `action` verbs → the timeline lane they belong to + a human label.
// The server's vocabulary is open; we recognize the common ones and fall back
// to a Title-Cased version of the raw verb for anything else (so a new server
// action still renders meaningfully instead of being dropped).
const ACTION_KIND = {
  create: 'created',
  created: 'created',
  claim: 'claimed',
  claimed: 'claimed',
  reclaim: 'claimed',
  renew: 'renewed',
  release: 'released',
  released: 'released',
  start: 'status',
  in_progress: 'status',
  complete: 'status',
  completed: 'status',
  done: 'status',
  partial: 'status',
  fail: 'status',
  failed: 'status',
  block: 'status',
  blocked: 'status',
  cancel: 'status',
  cancelled: 'status',
  reopen: 'status',
  reopened: 'status',
};

const ACTION_LABEL = {
  create: 'Created',
  created: 'Created',
  claim: 'Claimed',
  claimed: 'Claimed',
  reclaim: 'Re-claimed',
  renew: 'Claim renewed',
  renewed: 'Claim renewed',
  release: 'Released',
  released: 'Released',
  done: 'Completed',
  complete: 'Completed',
  completed: 'Completed',
  partial: 'Partial',
  fail: 'Failed',
  failed: 'Failed',
  block: 'Blocked',
  blocked: 'Blocked',
  cancel: 'Cancelled',
  cancelled: 'Cancelled',
  reopen: 'Reopened',
  reopened: 'Reopened',
  start: 'Started',
  in_progress: 'Working',
};

function titleCase(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Local-part of an email, else the raw principal. NON-PHI (an identity). */
export function shortActor(user) {
  if (!user) return 'unknown';
  const at = user.indexOf('@');
  return at > 0 ? user.slice(0, at) : user;
}

/**
 * Fold the audit trail + the task's mapped lifecycle fields into an ordered
 * timeline model (oldest → newest), classified into lanes the UI styles
 * distinctly. Returns [] when there's nothing to show.
 *
 * @param {Array<{user?:string, action?:string, detail?:string, at?:string}>} events
 *        audit rows (the source returns them NEWEST-first)
 * @param {{ createdAtIso?:string|null, createdBy?:string|null,
 *           claimedAt?:string|null, claimedBy?:string|null }} task
 * @returns {Array<{ kind:string, label:string, actor:string|null,
 *           at:string|null, detail:string }>}
 */
export function buildTimeline(events, task = {}) {
  /** @type {Array<{kind:string,label:string,actor:string|null,at:string|null,detail:string}>} */
  const rows = [];
  const list = Array.isArray(events) ? events.slice() : [];
  // Audit comes newest-first; sort ascending so the timeline reads top→bottom
  // = oldest→newest. Stable for equal/absent timestamps.
  list.sort((a, b) => {
    const ta = Date.parse(a?.at ?? '');
    const tb = Date.parse(b?.at ?? '');
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta - tb;
  });

  for (const e of list) {
    const rawAction = (e?.action ?? '').toLowerCase();
    const kind = ACTION_KIND[rawAction] || 'status';
    const label = ACTION_LABEL[rawAction] || titleCase(e?.action) || 'Update';
    rows.push({
      kind,
      label,
      actor: e?.user || null,
      at: e?.at || null,
      detail: e?.detail || '',
    });
  }

  // If the audit trail had no explicit "created" event but the task carries a
  // created timestamp, synthesize a Created anchor at the front so the timeline
  // always starts at birth. (Derived from real fields — not faked.)
  const hasCreated = rows.some((r) => r.kind === 'created');
  if (!hasCreated && task.createdAtIso) {
    rows.unshift({
      kind: 'created',
      label: 'Created',
      actor: task.createdBy || null,
      at: task.createdAtIso,
      detail: '',
    });
  }

  // Likewise, if the task is currently claimed but the audit trail didn't carry
  // a claim event (audit may be limited/truncated), synthesize the current
  // claim from the mapped fields so "who holds it now" is always on the line.
  const hasClaim = rows.some((r) => r.kind === 'claimed');
  if (!hasClaim && task.claimedBy && task.claimedAt) {
    rows.push({
      kind: 'claimed',
      label: 'Claimed',
      actor: task.claimedBy,
      at: task.claimedAt,
      detail: '',
    });
  }

  return rows;
}
