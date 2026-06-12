> **Superseded (2026-06-12):** the server shipped `PATCH /chromeext/{id}` as the management verb instead — see docs/task-api-v2-ui-plan.md.

# TypeBuild `complete` endpoint — server spec

**Status:** proposed — implement on `general.typebuild.com`.
**Client tracking:** bead `fm-v0rc` (Phase B). Breezefile already ships the
client half (`electron/sources/typebuild.ts` → `complete()`); it degrades
gracefully until this route exists (see [Rollout](#rollout)).

## Motivation

The Breezefile desktop ("Tasks" page) aggregates remote TypeBuild tasks beside
local tasks. The TypeBuild `/chromeext/*` surface today exposes
`list` / `get` / `claim` / `release` / `reopen` but **no mark-done path**. As a
result the desktop's primary per-row action for a TypeBuild task cannot
actually complete it — the user has to switch to the web app.

This spec adds a single verb, `POST /chromeext/{id}/complete`, so the desktop
can mark a TypeBuild task done directly. It mirrors the auth, error, and PHI
conventions of the existing `/chromeext/*` verbs so it slots in with no new
patterns.

## Endpoint: `POST /chromeext/{id}/complete`

Marks a task terminal (done/partial), records who completed it and when, and
releases any claim.

### Auth

Same as every other `/chromeext/*` verb: a **Firebase ID token bearer**
(`Authorization: Bearer <id_token>`), verified via the project's existing
`chromeext_firebase` path. No new scope. The verified principal (email) is
"the caller" referenced below.

### Request

Headers:

```
Authorization: Bearer <firebase_id_token>
Accept: application/json
Content-Type: application/json
```

Body (all fields optional):

```json
{
  "note": "Confirmed the fix in staging.",
  "outcome": "done"
}
```

| field     | type                   | default  | meaning                                              |
| --------- | ---------------------- | -------- | ---------------------------------------------------- |
| `note`    | `string`               | —        | Free-text completion note. **PHI** — see [PHI](#phi-note). |
| `outcome` | `"done" \| "partial"`  | `"done"` | Terminal status to set. `partial` = done-with-caveats. |

An empty body (`{}`) is valid and means "complete with outcome `done`, no note".

### Semantics

1. **Allowed when** the task is **unclaimed** OR **claimed by the caller**.
2. **Rejected (409)** when the task is **claimed by someone else**.
3. **Rejected (400)** when the task is **already terminal** (`done` / `partial`).
4. On success:
   - set `status`/`raw_status` to the `outcome` (`done` or `partial`);
   - record the completer (caller email) + a completion timestamp;
   - **release the claim** (so `claimed_by` becomes `null`).
5. The transition is idempotent only in the trivial sense: a second call on an
   already-terminal task returns **400** (rule 3), not 200.

### Responses

**200 — completed.** Body is the updated **list-row** for the task (the same
shape `GET /chromeext/tasks` rows use). **No PHI** in the body — routing fields
only, no decrypted `task` body. Example:

```json
{
  "id": "a1b2c3d4",
  "status": "done",
  "raw_status": "done",
  "claimed_by": null,
  "priority": 2,
  "attempts": 1,
  "max_attempts": 3,
  "completed_by": "vivekdse@gmail.com",
  "completed_at": 1717000000
}
```

(The desktop reads `id`, `status`/`raw_status`, `claimed_by`; extra fields are
ignored. It applies an optimistic local patch and re-pulls the list to
reconcile, so the exact body is non-critical as long as it is not an error.)

**409 — claimed by another principal.**

```json
{ "reason": "claimed", "claimed_by": "someone-else@example.com" }
```

The desktop surfaces this inline as "couldn't complete · claimed by
{claimed_by}". (Matches the existing `claim` 409 shape exactly — `reason` +
`claimed_by`.)

**404 — not visible.** The task id is not visible to the caller (or no such
task). Empty body acceptable.

> Note: the desktop currently cannot distinguish a route-level 404 ("endpoint
> not deployed yet") from a task-level 404 ("not visible"), so **before this
> route ships** it treats any 404/405 on `…/complete` as "complete not
> supported yet" and degrades quietly. After the route ships, a task-level 404
> is rare (the UI only offers complete on a visible row).

**400 — already terminal.**

```json
{ "reason": "already_terminal", "status": "done" }
```

**401 — signed out / token revoked.** Standard for the surface; the client
retries once with a refreshed token then surfaces signed-out.

## Reopen-from-done

The desktop's "reopen" action reuses the **existing**
`POST /chromeext/{id}/reopen` verb — no new client verb. Today `reopen` is
scoped to **blocked** tasks. Extend it to also accept **`done` / `partial` →
`open`** transitions so a mistakenly-completed task can be reopened from the
desktop.

- Auth + response shape: unchanged (same Firebase bearer; 200 returns the
  updated list-row, 404 not-visible).
- After reopen, `status`/`raw_status` return to `open` and the task is
  claimable again.
- No body required.

The desktop already calls `reopen` and optimistically patches
`status: pending / raw_status: open / completed_at: null`, so no client change
is needed once the server accepts the done→open transition.

## Rollout

The client ships **before** the server route and must not error when the route
is absent:

- The client treats **404 or 405** on `POST …/complete` as
  `{ ok: false, reason: 'complete-unsupported' }` and toasts "TypeBuild server
  doesn't support completing tasks from here yet". No throw, no broken row.
- When the route lands, completes start working with **no client release** —
  the same build picks it up.

**Optional (nice-to-have):** add a boolean `complete: true` capability flag to
the `GET /chromeext/tasks` response (top-level, alongside `tasks`) so the
desktop can hide the action entirely instead of attempting-then-degrading. Not
required for v1; the 404/405 degrade path is sufficient.

## PHI note

TypeBuild task titles and bodies are PHI. This endpoint upholds the same
invariant as the rest of `/chromeext/*`:

- **No decrypted task body** in the request or the response. The 200 body is a
  routing-only list-row (no `task` field).
- The optional **`note`** IS user content and must be stored **under the same
  encryption as task bodies** (the field is treated as PHI server-side). It is
  forwarded by the desktop but never logged or persisted to disk on the client.
- The server must not log `note` in plaintext.

## Out of scope

- **Bulk complete** — one id per call for v1. (The desktop partitions
  multi-select operations client-side and issues per-task calls.)
- **Attempts changes** — `complete` does not alter `attempts` / `max_attempts`.
- **Custom terminal statuses** beyond `done` / `partial`.
