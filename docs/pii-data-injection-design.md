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
