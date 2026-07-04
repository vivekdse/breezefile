// task-4a8d2c98f667 — pure helpers for the drawer's Inputs section (the task
// `data` bag: LIST key names, RESOLVE a value on demand, EDIT/ADD via a
// resolve-merge-replace PATCH, gated by claim/creator auth). Runtime is plain
// ESM so the node test runner imports it without a transpile step (mirrors
// taskAnswer.mjs / taskMessages.mjs). NO React, NO PHI persistence — a
// resolved value must live only in the component's React state, never here,
// never logged, never written to disk.

// Server-side key convention (docs/typebuild-data-field-contract.md §1):
// dotted lowercase, [a-z0-9._-]+, domain.field shape (e.g. "patient.ssn").
const KEY_RE = /^[a-z0-9._-]+$/;

/** Normalize a user-typed key the same way the server's convention expects:
 *  trim, lowercase. Does NOT validate shape — call isValidDataKey for that.
 *  Centralized so "what we send" and "what we validate" never drift. */
export function normalizeDataKey(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Whether a (already-normalized-or-not) key is a well-formed data key per
 *  the server's dotted-lowercase convention. Empty string is never valid. */
export function isValidDataKey(raw) {
  const key = normalizeDataKey(raw);
  return key.length > 0 && KEY_RE.test(key);
}

// Substrings that make a key look like it carries something sensitive enough
// to mask-by-default in the UI (a display heuristic only — it does not change
// what's encrypted server-side, which is everything). Matched against the
// normalized key with simple substring checks so "patient.ssn", "card.number",
// "policy.dob" etc. all mask without an exhaustive enumeration.
const SENSITIVE_HINTS = [
  'ssn',
  'dob',
  'birth',
  'password',
  'secret',
  'token',
  'pin',
  'card',
  'cvv',
  'account',
  'routing',
  'tax_id',
  'tax.id',
  'ein',
  'npi',
  'license',
  'passport',
  'member_id',
  'member.id',
  'policy',
  'address',
  'phone',
  'email',
];

/** Whether a data key LOOKS sensitive enough to mask-with-reveal by default.
 *  Best-effort display heuristic (spec item 2) — every key's VALUE is PHI
 *  regardless, so this only decides the default reveal state, never whether
 *  a value is fetched/handled carefully. */
export function looksSensitive(key) {
  const k = normalizeDataKey(key);
  if (!k) return false;
  return SENSITIVE_HINTS.some((hint) => k.includes(hint));
}

/** The key list to render: prefer the server's `data_keys` (task.dataKeys)
 *  when present; otherwise fall back to whatever keys this session has
 *  already learned about (resolved, or a legacy task-fields block's `values`
 *  keys), so a server that predates `data_keys` still shows something rather
 *  than a blank Inputs section. `sessionKnownKeys` and the result are both
 *  deduped, sorted for stable rendering. */
export function effectiveDataKeys(dataKeys, sessionKnownKeys) {
  const fromServer = Array.isArray(dataKeys) ? dataKeys.filter((k) => typeof k === 'string' && k) : [];
  const fromSession = Array.isArray(sessionKnownKeys)
    ? sessionKnownKeys.filter((k) => typeof k === 'string' && k)
    : [];
  const merged = new Set([...fromServer, ...fromSession]);
  return Array.from(merged).sort();
}

/** Auth-gating decision (spec item 5): who may read/edit a task's `data` bag.
 *  Per docs/typebuild-data-field-contract.md §3's recommended rule — claim
 *  holder always may; the creator is included client-side as a reasonable
 *  extension (queue-management judgment call the doc defers to the server —
 *  the server's own 403 is still the authoritative backstop; this only
 *  decides whether the CLIENT shows the editor optimistically or a clear
 *  locked message up front). group-admin is NOT decidable client-side (no
 *  group-membership data on the task) — such a viewer sees the editor and
 *  relies on the server's 200/403 to settle it. */
export function canEditTaskData({ claimedBy, createdBy, viewerEmail }) {
  if (!viewerEmail) return false;
  if (claimedBy && claimedBy === viewerEmail) return true;
  if (createdBy && createdBy === viewerEmail) return true;
  // Neither claimed-by-me nor created-by-me is decidable as "definitely not
  // allowed" — a group-admin may still be allowed server-side. Default to
  // "maybe" (true) so the UI attempts the action and surfaces the server's
  // 403 with a clear message, rather than presuming a lockout the server
  // never actually enforces for this viewer. Only a task with NO claim and NO
  // creator on record (can't happen server-side, but keep it total) falls to
  // the same "attempt it" default.
  return true;
}

/** Human-readable message for a data-read/write that the server rejected as
 *  forbidden (403) — spec item 5's "clear message" requirement, instead of a
 *  silent empty state. */
export function dataAuthDeniedMessage(kind) {
  return kind === 'write'
    ? 'Only the claim holder, the task’s creator, or a group admin can edit this task’s inputs.'
    : 'Only the claim holder, the task’s creator, or a group admin can view this task’s inputs.';
}

/** Build the { upsert, delete } shape describing one edit session's changes,
 *  from a draft map of key -> (value | null-for-delete) against the original
 *  known values. Keys whose draft value is unchanged from the original are
 *  omitted from `upsert` (a no-op edit shouldn't re-send a value that was
 *  never even resolved). A key present in `removedKeys` is moved to `delete`
 *  and dropped from `upsert` even if it was also edited. */
export function buildDataPatchPayload({ drafts, originals, removedKeys }) {
  const upsert = {};
  const del = [];
  const removed = new Set(Array.isArray(removedKeys) ? removedKeys : []);

  for (const key of Object.keys(drafts || {})) {
    if (removed.has(key)) continue;
    const draft = drafts[key];
    if (typeof draft !== 'string') continue;
    const original = originals ? originals[key] : undefined;
    if (draft === original) continue; // unchanged — nothing to send
    upsert[key] = draft;
  }
  for (const key of removed) {
    del.push(key);
  }
  return { upsert, delete: del };
}

/** Whether a patch payload actually has something to send — guards the Save
 *  button / the IPC call from firing a no-op round-trip. */
export function hasPendingDataChanges(payload) {
  if (!payload) return false;
  return Object.keys(payload.upsert || {}).length > 0 || (payload.delete || []).length > 0;
}

/** The sibling key list to preserve across a full-bag-replace PATCH: every
 *  known key EXCEPT the ones this save is upserting or deleting (task-data.ts
 *  patchTaskData resolves these itself before replacing the bag). */
export function siblingKeysForPatch(allKnownKeys, payload) {
  const touched = new Set([
    ...Object.keys((payload && payload.upsert) || {}),
    ...((payload && payload.delete) || []),
  ]);
  return (Array.isArray(allKnownKeys) ? allKnownKeys : []).filter((k) => !touched.has(k));
}
