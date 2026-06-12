// fm-h8g7 — PURE transition classifier for the TypeBuild poll path.
//
// Authored as plain ESM (with a co-located .d.mts for the TS app) so
// `node --test tests/` can import it directly — Node here has no TS loader,
// mirroring the src/components/tasks/sections.mjs pattern.
//
// The poll diffs FRESH server rows against the CURRENT in-memory cache (the
// `prevRows` argument here) — NOT against the previous poll snapshot. That is
// the self-suppression mechanism: any action this app takes (claim / release /
// reopen / complete) already patched the cache via patchCacheAndBroadcast, so
// by the time the next poll runs the cache already reflects the new state and
// produces NO transition. Only genuinely REMOTE changes (someone else moved a
// task, a server agent finished one) differ from the cache and surface here.
//
// PHI invariant (non-negotiable): inputs are minimal routing-only objects
// ({id, status, rawStatus, claimedBy}) — NEVER titles or bodies. The output
// carries only the opaque task id + a transition kind. Nothing here touches
// disk, logs, or notifications; the caller turns these into PHI-free labels.

/** @typedef {{ id: string, status?: string, rawStatus?: string, claimedBy?: string|null }} TRow */
/** @typedef {'new'|'completed'|'partial'|'cancelled'|'blocked'|'claim-lost'} TransitionKind */
/** @typedef {{ taskId: string, kind: TransitionKind }} Transition */

const DONE_RAW = new Set(['done']);
const PARTIAL_RAW = new Set(['partial']);
const CANCELLED_RAW = new Set(['cancelled']);
const BLOCKED_RAW = new Set(['blocked']);

/** Treat both the source-native rawStatus and the mapped status as terminal
 *  'done' signals so a row that only carries status='done' still counts. */
function isDoneRow(row) {
  return row.status === 'done' || DONE_RAW.has(row.rawStatus ?? '');
}
function isPartialRow(row) {
  return PARTIAL_RAW.has(row.rawStatus ?? '');
}
// fm-alfz (S1) — cancelled maps status→'cancelled' (see typebuild.ts
// mapStatus), so check the mapped status too for rows carrying only `status`.
function isCancelledRow(row) {
  return row.status === 'cancelled' || CANCELLED_RAW.has(row.rawStatus ?? '');
}
function isBlockedRow(row) {
  return BLOCKED_RAW.has(row.rawStatus ?? '');
}

/**
 * Classify remote transitions between the cached rows and the fresh poll.
 *
 * @param {TRow[]} prevRows  rows from the CURRENT cache (pre-replacement)
 * @param {TRow[]} freshRows rows from the just-fetched list
 * @param {string|null} myEmail the signed-in principal (for claim-lost)
 * @param {boolean} isFirstPoll true on the first poll after construction /
 *        sign-in — suppresses 'new' for the whole initial inventory so the
 *        user isn't spammed with "new task" for every pre-existing row.
 * @returns {Transition[]}
 */
export function classifyTransitions(prevRows, freshRows, myEmail, isFirstPoll) {
  const prev = new Map((prevRows ?? []).map((r) => [r.id, r]));
  const out = [];

  for (const fresh of freshRows ?? []) {
    const before = prev.get(fresh.id);

    // New task: present in fresh, absent from cache. Suppress on the first
    // poll — the entire starting inventory is "new" then, which is noise.
    if (!before) {
      if (!isFirstPoll) out.push({ taskId: fresh.id, kind: 'new' });
      continue;
    }

    // Status transitions: fire only on the EDGE (was-not → is-now) so a row
    // that sits in a terminal state across polls doesn't re-notify. Check
    // PARTIAL before DONE: a partial row maps status→'done' (see
    // typebuild.ts mapStatus), so isDoneRow would also match it — partial is
    // the more specific signal and must win.
    if (isCancelledRow(fresh) && !isCancelledRow(before)) {
      // fm-alfz (S1) — a human/agent cancelled this task. Terminal; fires once
      // on the edge. Checked before done/partial — they share no raw with
      // cancelled, but ordering it first keeps the intent explicit.
      out.push({ taskId: fresh.id, kind: 'cancelled' });
    } else if (isPartialRow(fresh) && !isPartialRow(before)) {
      out.push({ taskId: fresh.id, kind: 'partial' });
    } else if (isDoneRow(fresh) && !isDoneRow(before)) {
      out.push({ taskId: fresh.id, kind: 'completed' });
    } else if (isBlockedRow(fresh) && !isBlockedRow(before)) {
      out.push({ taskId: fresh.id, kind: 'blocked' });
    }

    // Claim lost: the cache had it claimed by ME, the fresh row dropped my
    // claim (released) or handed it to someone else (taken over). Only
    // meaningful when we know who we are.
    if (
      myEmail &&
      before.claimedBy === myEmail &&
      fresh.claimedBy !== myEmail
    ) {
      out.push({ taskId: fresh.id, kind: 'claim-lost' });
    }
  }

  return out;
}
