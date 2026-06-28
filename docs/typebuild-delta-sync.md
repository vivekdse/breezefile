# TypeBuild task sync: skeleton cache + delta sync

How the TypeBuild client keeps its task list fresh against the online service
without re-pulling everything every poll, and without ever persisting PHI.

## Layers

1. **In-memory cache** (`TypeBuildTaskSource.cache`, `electron/sources/typebuild.ts`)
   — the live `Map<id, SourcedTask>` the renderer reads through. Carries titles
   (PHI) **in memory only**; bodies are fetched on demand.
2. **PHI-free persistent skeleton** (`electron/sources/task-skeleton-store.ts`,
   schema in `task-skeleton-schema.mjs`) — a sqlite db at
   `~/.breezefile/typebuild-skeleton.db` holding ONLY the non-PHI routing
   skeleton (status/claim/counts/timestamps/ids). **No title/body/notes column,
   by construction** — the `parseColumnNames` + `isPhiColumn` test enforces it.
   Backs the cache so Home renders instantly on cold start before any network.

## Phase 1 — instant cold start (commit 6fe1691 / cebcaab)

On construction the source hydrates the cache from `loadLiveSkeleton()`. Each
poll did a **full pull** (`GET /chromeext/tasks?titles=1&all=1`), signature-
compared, reconciled the skeleton (upsert + absence-tombstone), and broadcast a
`{added, changed, removed}` diff. The list endpoint had no real timestamps, so
`mapListRow` stamped `now()` as a benign placeholder floor.

## Phase 2 — true delta sync (task-b1fe80e2669b)

### Sync cursor (non-PHI)
A tiny kv table `sync_meta(k, v)` holds one row: `sync_cursor` = the last
`server_time` the delta endpoint returned. A cursor is a **timestamp** —
categorically non-PHI. `getSyncCursor()` / `setSyncCursor()` read/write it;
`clearSkeleton()` (sign-out) wipes it so a new principal re-seeds with a full
pull rather than replaying the prior account's watermark.

### Poll loop
- **No cursor (first poll after sign-in / cold start)** → **full seed pull**:
  `?updated_since=1970-01-01T00:00:00Z` returns the whole inventory PLUS the
  delta envelope (`server_time`, `tombstones`). We reconcile against the
  complete set (absence-based tombstoning) and capture `server_time` as the
  cursor. An older server that ignores `updated_since` just returns `{tasks}`
  and we stay on full pulls — fully backward compatible.
- **Cursor present** → **delta pull** `?updated_since=<cursor>&titles=1&all=1`:
  the server returns only rows with `updated_at > cursor`, a `tombstones` list,
  and a fresh `server_time`. We **upsert only the changed rows** into cache +
  skeleton, **apply the tombstones directly** (delete those ids — we do NOT
  infer removal from absence), broadcast the diff, then advance the cursor to
  the new `server_time` (advanced LAST, after a successful apply, so a crash
  mid-apply replays the window rather than skipping it).
- **Safety-net full reconcile** — every `FULL_RECONCILE_EVERY` (10) polls we do
  a full pull anyway to converge on server truth in case a tombstone was ever
  missed. At the 30s cadence that's a full reconcile roughly every **5 minutes**.

### Delta diff vs full diff
`diffSkeleton(prev, fresh)` (full) infers removal from absence.
`deltaSkeleton(prev, changedFresh, tombstoneIds)` (delta) only counts a removal
when the id is an **explicit tombstone that was actually live** — the unchanged
majority simply isn't in the payload and must be preserved. Both are pure ESM in
`task-skeleton-schema.mjs` so the store and the tests share one definition.

### Edge cases
- **Empty delta** (no changed rows, no tombstones) → advance cursor, skip the
  broadcast entirely (cheap no-op).
- **Server omits the delta envelope** (no `server_time`, no `tombstones`) → treat
  the response as a full pull (the `tasks` are the whole inventory).
- **Missing/empty `server_time`** → don't advance the cursor; the next poll
  replays the same window rather than skipping changes.
- **Offline / failed pull** → keep the last-known cache AND the old cursor; retry
  next tick. We never wipe the list on error.

### Real timestamps (attention-floor note)
`mapListRow` now uses the server's real `created_at` / `updated_at` (ISO-'Z'),
falling back to the `now()` floor only when the server omits them. This is
**strictly better** for `src/projects/attention.mjs`: a non-terminal row's real
past `updated_at` is below the page-mount `activityFloorMs`, so it counts as
**known** activity (`sawRealActivity`) reflecting its true last-touch — instead
of the Phase-1 `now()` placeholder that sat AT the floor and read as "unknown".
A non-terminal row therefore never looks artificially fresh or artificially
stale. The floor now only screens the rare fallback case. `created_at` keeps an
earliest-seen floor in the upsert (stable create-time sort key); `updated_at`
takes the latest server value. Staleness (`isStalledRow`) still uses the **claim
timestamp**, not `updated_at` — `updated_at` is "last mutated", the wrong clock
for "time in status".

## PHI invariant
Titles/bodies are PHI and stay in cache memory only. Delta rows hydrate titles
into the cache exactly as the full pull does; nothing PHI ever reaches the
skeleton db (the no-PHI-columns test covers the new `sync_meta` table too).
