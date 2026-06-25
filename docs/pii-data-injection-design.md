# Design decision: PII/data injection for browser automation

**Status:** Accepted (design) — implementation pending
**Date:** 2026-06-18
**Context:** TypeBuild-driven browser automation (`spike/playwright-cdp`), epic `fm-ubk`
**Related:** [`docs/Playwright agent.md`](Playwright%20agent.md) (tool-repository vision),
`electron/sources/typebuild.ts`, `electron/browser/cli.mjs`, `electron/api-server.ts`

---

## Problem

A core goal of the browser-automation work is to fill web forms with **PII and
other data that originates from an API** (TypeBuild tasks). Today the agent
receives the full decrypted task body over MCP and would type values directly —
so any PII in the body is already in the agent's context, PTY, argv, and any
logs/screenshots it produces.

We want a model where the **agent works with placeholders (field names), and a
script does the actual filling with the real values**, so PII stays out of the
agent's context in normal operation.

## Decision

Adopt a **placeholder-fill** design with these two choices locked in:

1. **Threat model: cooperative boundary (NOT adversarial).**
   The mechanism reduces *accidental* PII exposure in the agent's context/logs.
   It does **not** defend against an agent that deliberately tries to read the
   values. See the trust constraint below — this is the load-bearing decision.

2. **Key custody: server-side at rest only.**
   The TypeBuild server holds the encryption key and decrypts on request.
   "Encrypted" means encrypted-at-rest; the real access control is *which caller*
   the server returns plaintext to (Breeze main — never the agent's MCP context).
   No client-held keys, no end-to-end key distribution.

### ⚠️ Load-bearing constraint: agents MUST be trusted

This design only protects PII if the agent is trustworthy, because the agent can
**read pages (`snapshot`/`text`), screenshot, and `eval` arbitrary JS** against
the same page it just filled. Concretely:

- After a `fill-ref`, the agent can recover the value with
  `eval document.querySelector('#ssn').value`, or via `snapshot`/`text`.
- `screenshot` (`cli.mjs:226`) writes a PNG into the agent's `--add-dir`'d cwd
  and the agent **Reads it back** — a screenshot of a filled form puts the PII
  *visibly* into the agent's context.

Therefore the placeholder boundary is a **convention that keeps a cooperating
agent's context clean**, not a sandbox. **We cannot run agents we do not trust
on tasks that carry PII.** Any future move to untrusted/third-party agents would
require a different design (hard boundary: main-process resolve+fill, plus
locking down eval/read-back/screenshot on PII fields).

## Three data classes (class 2 added)

A value a form needs is exactly one of three classes. The agent surface is
identical for classes 1 and 2 — it fills a placeholder KEY and never sees the
value; only Breeze main's resolver (`electron/typebuild/task-data.ts`) routes
the ref to the right server source by its prefix.

1. **Patient/customer PHI** — about the customer the task is for (SSN, DOB,
   member id…). Encrypted **per task** on that task's `data` bag, resolved by
   `(taskId, ref)` with arbitrary keys (e.g. `patient.ssn`). Lives in the active
   session only. This is the original class above.
2. **The user's OWN credentials/identifiers** — their NPI, the practice Tax ID,
   portal login IDs (NOT passwords). **Per-user, reusable across all of that
   user's tasks**, NOT patient PHI, NOT shared cross-user. Addressed by a
   reserved **`me.` ref prefix** (e.g. `me.npi`, `me.taxId`, `me.availity.login`,
   or location-scoped `me.npi.<location>`) and resolved against a **per-user
   credential vault**, independent of any task. *(This class is the new
   addition.)*
3. **Shared NON-PHI how-to** — navigation prose in skills/memory (which button,
   what the field is named). Shared cross-user. **Never a value.**

**Threat model for class 2 is UNCHANGED** — same cooperative boundary as class 1.
The agent fills a `me.*` KEY via `fill-ref`/`type-ref` and never receives the
value, but it could still screenshot or read back the filled field; class 2
therefore requires trusted agents exactly as class 1 does.

### The `me.` reserved namespace and the per-user vault

- A ref starting with `me.` (`USER_REF_PREFIX` in `task-data.ts`) means "the
  signed-in user's own credential vault", not the task `data` bag. Scoping is by
  the Firebase token; **no `taskId` is involved** for a class-2 fill.
- Keys are a safe dotted-identifier shape (`^me\.[A-Za-z0-9._-]+$`); the
  management UI accepts a short key (`npi`) and namespaces it to `me.npi`.
- **The client persists NO class-2 plaintext at rest.** The **server is the
  source of truth** (encrypted at rest, per-user, Firebase-authed). Listing
  returns key NAMES only; a value crosses the wire only on an explicit reveal or
  an agent fill, **one value per call, uncached** — same memory-only/transient
  discipline as PHI.

#### Class-2 resolve — the entity resolver (what shipped)

The per-user vault shipped as TypeBuild task `task_manager_api-8y0`; the Breeze
client side is `task-57862d425ef1` (resolver `task-data.ts`, vault CRUD
`user-vault.ts`, the `:secrets` management UI). **The class-2 fill/reveal path
resolves through the entity resolver, NOT `GET /chromeext/me/data?ref=`** (that
assumed endpoint never shipped). The `me.*` namespace is unchanged.

```
GET /chromeext/entities/resolve?field=<name>&entity=<id|me>&format=<fmt>
```

- `entity` **defaults to `me`** — omitted for the `me.*` case; `field` required.
  Firebase-authed, scope-checked, value crosses only this hop, never logged.
- **`me.*` → request:** strip `me.`, the remainder is `field` (`me.npi` →
  `?field=npi`). The server canonicalizes aliases (`npi`, `tax_id`/`ein`,
  `login_id`, `practice_name`) and hard-refuses secret fields, so the client
  passes the bare field name.
- **Response shapes (exact):**
  - `{ "resolved": true,  "field": "<canonical>", "value": "<string>" }`
  - `{ "resolved": false, "reason": "not_found",  "available": ["<names>"] }`
  - `{ "resolved": false, "reason": "ambiguous",  "candidates": ["<names>"] }`
  - `{ "resolved": false, "reason": "ambiguous_secret" }` (NO names)
- **Client handling** (`resolveUserField`): `resolved:true` → the string `value`
  (empty → "no data", same as class 1, never logged); `not_found` → error that
  may list non-secret `available` names; `ambiguous` → error that may list
  `candidates`; `ambiguous_secret` → generic refusal disclosing **nothing**. No
  value is ever logged (the false branches carry none).
- **Supporting (names only, not needed for fill):** `GET /chromeext/entities`
  (list), `GET /chromeext/entities/me` (self field names), `GET /chromeext/entities/{id}`.

The vault **CRUD** (`user-vault.ts` list/PUT/DELETE for the `:secrets` panel)
still targets `/chromeext/me/data`; migrating it onto the entity API is a
follow-up. All paths are scoped to the signed-in user by the Firebase token.

**Open question — multi-value disambiguation.** A user may have more than one of
the same kind of identifier (e.g. an NPI per practice location). The shipped
model uses **separate entities** (`entity=<id>`), not a flattened
`me.npi.<location>` key. The client always resolves `me.*` against the `me`
self-entity today; when multiple match, the resolver returns `ambiguous`.
**Client-side multi-entity / location selection (a picker, or location inferred
from task context) is a follow-up.**

## Architecture

```
TypeBuild server  ──(decrypted data, Firebase token)──▶  Breeze main (api-server)
   (holds key,                                              │
    decrypts at rest)                                       │ localhost /app/* + api.json token
                                                            ▼
                                              cli.mjs  ──fill──▶  CDP ──▶  page
   agent: emits {{patient.ssn}} placeholders only           ▲
                                                            (value lives in the
                                                             script's process memory,
                                                             never printed to stdout)
```

Pieces:

1. **`data` field on the TypeBuild task** — encrypted-at-rest JSON, e.g.
   `{"patient.first":"…","patient.ssn":"…"}`.
2. **MCP exposes keys, never values** — `get_task` returns `data_keys: [...]`
   (or the body lists them) so the agent knows which placeholders exist.
   Authoring discipline: **PII goes in `data`; the body carries only
   `{{...}}` placeholders.** Without this the agent still sees PII in the body.
3. **Fetch decrypted values through Breeze main, NOT through MCP.** Fetching via
   an MCP tool would return the values into the agent's context. Instead the
   script calls Breeze main's localhost control API (the `~/.breezefile/api.json`
   token — same seam `open` already uses, `cli.mjs`); main resolves ONE ref at a
   time via `GET /chromeext/<id>/data?ref=<key>` with its Firebase token and
   returns just that value. Endpoint: `GET /app/task-data?taskId=…&ref=…` in
   `api-server.ts` (delegates to `electron/typebuild/task-data.ts`). Resolving a
   single ref per call keeps the whole `data` bag from ever sitting in main's
   heap or crossing the localhost hop — only the value being filled does, and it
   is not cached.
   - *Why main, not the script directly:* the PTY child has only
     `TYPEBUILD_MCP_TOKEN` (the MCP JWT), not the Firebase ID token that
     `/chromeext/*` REST requires (`typebuild.ts:342`). Routing through main
     reuses main's Firebase token and avoids teaching the server to accept the
     MCP JWT for REST.
4. **`cli.mjs fill-ref <selector> <ref>`** — fetch+cache decrypted `data`,
   resolve `ref` → value, `loc(page,sel).fill(value)`, and print only
   `filled <selector> (<ref>)`. **The value never touches argv or stdout.**
5. **Task id in the env** — `launchSession` currently injects only
   `BREEZE_TYPEBUILD_TASK=1` (a marker, `typebuild.ts:846`). Add
   `BREEZE_TYPEBUILD_TASK_ID=<id>` (the id is opaque/non-PHI) so the script
   knows which task's data to fetch.

## Leak paths to keep closed

Even under the cooperative model these defeat the purpose if left open:

- **stdout/stderr** — `fill` must never echo the value; resolve errors must not
  print it either (`could not fill SSN=123-…`). `fill`/`fill-ref` print only the
  selector + opaque ref.
- **Playwright "Call log:" on a failed fill (found + fixed)** — a fill/type that
  fails *after* the value is in hand (routine selector timeout, non-editable
  element) throws an error whose "Call log:" block interpolates the literal typed
  value (`fill("123-45-6789")`). Unscrubbed, that reaches the agent via stderr.
  `fill-ref`/`type-ref` now wrap the action in a try/catch and run the error
  through `scrubError(e, value)` (redacts the value, drops the call-log block,
  keeps one bounded line) so it never reaches the generic `main().catch`.
- **argv** — carries the placeholder/ref, never the value (the design already
  does this).
- **screenshot of filled forms** — see the trust constraint. Needs a rule:
  don't screenshot filled PII forms, or mask those fields.

## Consequences

- **Tightens** the current PHI posture: today the agent sees PHI in the body;
  this pulls it out into `data`.
- Small Breeze-side build: 1 control endpoint (`api-server.ts`), 1 `cli.mjs`
  verb, 1 env var.
- **Blocking dependency on TypeBuild server:** the `data` column, the
  decrypted-data fetch endpoint, and keys-not-values over MCP are server-side and
  cannot be built in this repo.
- **Operational rule:** PII tasks may only be assigned to trusted agents.

## Rejected alternatives

- **Hard boundary (main does resolve+fill, agent never able to obtain values).**
  Stronger, but requires a main-process CDP fill path and locking down
  eval/read-back/screenshot. Deferred — only needed if we ever run untrusted
  agents. Revisit this doc if that changes.
- **End-to-end client-held key.** Server can't read the data; only Breeze holds
  the key. Strongest at-rest story, but adds key distribution/management to
  Breeze. Rejected for now in favor of server-side-at-rest simplicity.
- **Fetch values via an MCP tool.** Simplest plumbing, but returns the values
  into the agent's context — defeats the entire purpose.
