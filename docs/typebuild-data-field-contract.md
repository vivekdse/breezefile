# Contract: TypeBuild task `data` field (cooperative-boundary PII fill)

**Status:** Proposed — for the TypeBuild server team
**Date:** 2026-06-18
**Audience:** TypeBuild server team (this is the server-side dependency)
**Related:** [`docs/pii-data-injection-design.md`](pii-data-injection-design.md) (decision + threat model),
`electron/typebuild/task-data.ts`, `electron/api-server.ts`, `electron/sources/typebuild.ts`,
`electron/browser/cli.mjs`

---

## Summary for the server team

Breeze fills web forms with PII that originates from a TypeBuild task. The browser
agent must work with **placeholder keys only** and never see the real values. To
make that work the server needs to:

1. Add a `data` field to a task: a flat `string → string` map, encrypted at rest
   with the **same scheme task titles/bodies already use**.
2. Accept `data` on the **same create/update payload** that `task`/`title` ride
   (`POST /chromeext/tasks`, `PATCH /chromeext/<id>`).
3. Serve a **single-ref decrypt endpoint** that Breeze main already calls:
   `GET /chromeext/<id>/data?ref=<key>` → `200 { "value": "<decrypted>" }`.
4. Expose the **keys (never values)** to the agent over MCP as a `data_keys`
   array on the task detail.
5. Make data reads **auditable** without ever putting a value in audit/logs/lists.

The Breeze side (main resolver, control endpoint, `fill-ref`/`type-ref` helper,
env wiring) is built and merged (commit `9682a9f`). Only the server side is
outstanding.

> **Threat model (locked):** this is a **cooperative** boundary, **not** a sandbox.
> The agent is trusted; it can still read or screenshot the field it just filled.
> The goal is keeping PII out of the agent's context in **normal** operation — not
> defending against a malicious agent. Server-side-at-rest decryption with
> per-caller access control is the whole mechanism. See the design doc.

---

## 1. The `data` field

A task gains one new field, `data`:

- **Type:** a **flat JSON object**, **string keys → string values**.
  - `{ "patient.first": "Jane", "patient.ssn": "123-45-6789" }`
  - **Not** nested. Keys are flat dotted strings, not a tree.
- **Keys** are **opaque, non-PHI identifiers** chosen by the task author. They are
  the placeholders the agent sees. They MUST NOT themselves encode PHI
  (`patient.ssn` is fine; `ssn.123-45-6789` is not).
  - **Naming convention (required):** **dotted lowercase**, `[a-z0-9._-]+`,
    `domain.field` shape — e.g. `patient.ssn`, `patient.dob`, `policy.member_id`,
    `card.number`. No spaces, no uppercase, no PHI in the key. Treat keys as
    case-sensitive and match them exactly.
- **Values** are **always strings.** A date is `"1980-04-12"`, a number is
  `"42"`. The resolve endpoint returns a JSON string and nothing else.
  - **If a structured value is ever needed** (a list, an object), the author
    **JSON-encodes it into the string** and the *consumer* parses it. The `data`
    map stays `string → string`; the server never stores or returns non-string
    leaf values. (Breeze's resolver rejects a non-string `value` today —
    `task-data.ts` throws if `typeof value !== 'string'`.)
- **Encryption:** `data` values are **encrypted at rest with the same scheme and
  key custody as the task `title`/`task` body.** No new key, no client-held key,
  no end-to-end distribution. "Encrypted" here means encrypted-at-rest; the real
  access control is *which caller* the server decrypts for (§3).
- **Absence:** a task with no `data` behaves as `data = {}` (or `null`). It is
  optional; most tasks won't have it.

## 2. How authors put data in

`data` rides the **existing create/update payloads** — no new write endpoint.

- **Create — `POST /chromeext/tasks`** (Breeze: `createTask`, `typebuild.ts`
  ~L476). The payload today is `{ title, task, start_url?, skill_ids?, flags?,
  priority?, due_at?, defer_until?, parent_task_id?, depends_on? }`. **Add an
  optional `data` member** of the shape in §1:

  ```jsonc
  POST /chromeext/tasks
  {
    "title": "File patient intake for {{patient.first}}",
    "task":  "Open the intake form and fill it from the data placeholders.",
    "data":  { "patient.first": "Jane", "patient.ssn": "123-45-6789" }
  }
  ```

  The server encrypts each `data` value at rest exactly as it encrypts `title`/
  `task`. Validate: object, string keys matching `[a-z0-9._-]+`, string values;
  reject (`400`, `reason: "bad_data"`) otherwise.

- **Update — `PATCH /chromeext/<id>`** accepts `data` as a **full replacement**
  of the map (last-writer-wins on the whole bag). Omitting `data` leaves it
  unchanged; sending `{}` clears it. (We do not need per-key patch semantics in
  v1 — state the behavior you pick.)

- **Authoring rule (load-bearing):** **PII goes in `data`; the `title`/`task`
  body carry only placeholder keys (`{{patient.ssn}}`), never raw PII.** Without
  this discipline the agent still sees PII in the decrypted body it gets over MCP.
  The server can't enforce it, but please document it for authors and the
  extension UI.

## 3. The single-ref decrypt endpoint (already called by Breeze)

Breeze main (`electron/typebuild/task-data.ts`) **already issues this request**;
the server needs to answer it:

```
GET /chromeext/<id>/data?ref=<key>
Authorization: Bearer <Firebase ID token>
Accept: application/json
```

- **One value per call, never the bag.** The endpoint returns the single decrypted
  value for exactly the `ref` asked for. It MUST NOT accept a "give me everything"
  form and MUST NOT return the whole `data` map. Resolving one ref per call is
  deliberate: it keeps the full bag from ever crossing the wire or sitting in
  Breeze's heap — only the value being filled does, and Breeze does not cache it.
- **Auth:** Firebase **ID token Bearer**, identical to every other `/chromeext/*`
  REST call (`typebuild.ts request()` helper sets `Authorization: Bearer
  <getIdToken()>`). This is **not** the MCP JWT — the agent's PTY never holds the
  Firebase token, which is exactly why this hop goes through Breeze main.
- **The value MUST NEVER be logged**, put in an audit `detail`, echoed in errors,
  or returned by any list/detail endpoint. Only this endpoint, only in the `200`
  body, only the one requested value.

### Responses (define every one)

| Status | Body | When |
|--------|------|------|
| **200** | `{ "value": "<decrypted string>" }` | `ref` exists in this task's `data` and the caller may read it. `value` is always a JSON string. |
| **401** | `{ "error": "...", "reason": "unauthenticated" }` | Missing/invalid/expired Firebase token. (Breeze retries once with a fresh token, then surfaces signed-out.) |
| **403** | `{ "error": "...", "reason": "forbidden" }` | Caller is authenticated and the task is visible to them, but they are **not allowed to read `data`** under the access rule below. |
| **404** | `{ "error": "...", "reason": "not_found" }` | Task not visible to caller / task has no `data` / `ref` is an unknown key. |

- **Breeze's current handling** (`task-data.ts`): `404` → "no data for ref" error
  (no value, just the opaque key); any other non-200 → treated as a `502`-class
  transport failure; a non-string `value` → rejected. So **`200` MUST carry a
  string `value`**, and **`404` is the "nothing to fill" signal**. Breeze does
  not today branch on `403` separately from other non-200s, but please return it
  correctly so audit/diagnostics are truthful (and so we can add a distinct
  message later).
- **404 collapses three cases on purpose** (task-not-visible, no-data, unknown-key)
  so the error surfaced to the agent reveals nothing about *why*. If you would
  rather distinguish unknown-key from forbidden, see open questions — but the
  agent-facing error must stay value-free regardless.
- **Empty value is "no data", not a fill.** A `200 { "value": "" }` would cause a
  silent empty fill that *reports success*. Breeze treats an empty-string `value`
  as a 404-equivalent ("no data for ref") rather than filling a field with
  nothing. Prefer the server return `404` for an absent/empty key; if a key
  legitimately maps to the empty string, that case is unsupported by the
  placeholder-fill path by design.

### Access rule (who may read `data`) — Breeze's recommendation

**Only the current claim holder of the task may read its `data`.** Rationale: the
fill only happens during an active, claimed work session; a value should be
readable exactly when someone is doing the work that needs it.

- Caller **holds the claim** → `200`.
- Caller can **see** the task but does **not** hold the claim → `403`
  (`reason: "not_claimed_by_caller"` or similar).
- Caller **can't see** the task at all → `404`.

The task **creator/admin** reading `data` for queue management is a judgment call
we defer to you (see open questions). Breeze itself only ever calls this endpoint
from within a claimed, Breeze-launched session, so the claim-holder rule covers
100% of Breeze's usage.

## 4. MCP side — keys, never values

The `/work` flow and `get_task` (MCP) hand the agent its task detail. That detail
**must include the placeholder keys so the agent knows which `fill-ref` calls are
available — and must never include the values.**

- Add a **`data_keys`** array to the MCP task detail (`get_task`, and the task
  object the `work` prompt surfaces):

  ```jsonc
  {
    "id": "…",
    "title": "…",
    "task":  "…",            // body — placeholders only, never raw PII
    "data_keys": ["patient.first", "patient.ssn", "policy.member_id"]
  }
  ```

- `data_keys` is **the sorted list of keys** in the task's `data` map. **No
  values, ever.** It is the agent's menu of placeholders.
- The MCP layer MUST NOT expose the values through **any** tool — not `get_task`,
  not a hypothetical `get_data`, not search results, not notes. The *only* path
  to a value is `GET /chromeext/<id>/data?ref=…` authenticated with the **Firebase
  token** (which the MCP/PTY context does not have). Do not teach the MCP server
  to vend values.
- **Authoring rule restated for MCP:** since the agent receives the decrypted
  `task` body over MCP, that body must contain only placeholder keys. PII lives
  solely in `data`.

## 5. Audit / compliance

- **Reads are auditable.** Each `GET …/data?ref=<key>` SHOULD produce an audit
  event: **who** (principal), **which key** (the opaque `ref`), **when**, and the
  task id. This lets us answer "who read `patient.ssn` on task X and when."
- **Values never appear in audit.** The audit `detail` field (the existing
  `GET /chromeext/audit` returns `{ user, action, detail, at }`, consumed by
  `typebuild.ts getAudit`) MUST carry only the **key**, never the resolved value.
  Same for application logs and metrics.
- **No value in list/detail/search.** `GET /chromeext/tasks`, `GET /chromeext/<id>`,
  and search MUST NOT return `data` values. Returning `data_keys` on the detail is
  fine and expected (§4); returning the bag's values is not.
- Writing `data` (create/update) is auditable as a normal task mutation; the audit
  `detail` for a write must not echo the written values either (e.g. log
  "set data keys: patient.ssn, patient.first", not the values).

## 6. Open questions for the TypeBuild team

1. **Exact access rule.** We recommend **claim-holder-only** (§3). Do you also
   want the **creator/admin** to be able to read `data` (e.g. for support/debug)?
   If so, that read should still be audited the same way.
2. **404 vs 403 granularity.** We collapse unknown-key / no-data / not-visible
   into `404`, and forbidden into `403`. Are you comfortable distinguishing
   *unknown-key* (caller may read data, but this key doesn't exist) from
   *forbidden* (caller may not read data at all)? Breeze doesn't need the
   distinction today; it just must never leak a value or a reason that implies one.
3. **`PATCH data` semantics.** We assumed **full-bag replacement** (§2). Do you
   want per-key merge/delete instead? Either is fine for Breeze v1; we need it
   stated.
4. **Key validation strictness.** Is `[a-z0-9._-]+` dotted-lowercase acceptable to
   enforce server-side at write time, or do you want a looser/stricter charset?
5. **Encryption envelope.** Confirm `data` values reuse the **exact** at-rest
   scheme/key as `title`/`task` (no separate key, no rotation skew) so we inherit
   the same guarantees with no new key management.
6. **MCP detail placement.** Is `data_keys` on the `get_task` payload the right
   shape, or do you prefer it surfaced via the `work` prompt text? Breeze only
   needs the keys reachable to the agent; the exact field is yours to pick.
