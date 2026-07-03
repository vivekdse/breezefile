# Saved Queries: external data sources for forms and dynamic tasks

**Status:** design approved in conversation (2026-07-02); v1 slice filed in TypeBuild.
**Related:** [`typebuild-data-field-contract.md`](typebuild-data-field-contract.md),
[`pii-data-injection-design.md`](pii-data-injection-design.md).

## Problem

Two product scenarios need the task system to talk to external APIs (EHRs first,
anything REST later):

1. **Selectors in task-creation forms.** A template field like "Patient" should be
   a typeahead/dropdown backed by a live API query, and selecting a row should give
   the task (and agents working it) durable access to the underlying resource — not
   just a display string.
2. **Data-driven task generation.** When external data changes (e.g. a patient is
   flagged for surgery in the EHR), the system should automatically instantiate a
   task chain for the relevant project (insurance authorization → surgery-center
   coordination → PCP notification), with each task bound to the right resource.

Both must ride ONE underlying mechanism, available identically to every client
(Electron today, web/headless later), scalable across use cases, and customizable
per project.

## Decisions

- **REST-only transport.** All sources are accessed over HTTPS/REST. FHIR is
  already REST (Epic, Cerner, athenahealth expose FHIR R4 + OAuth); legacy HL7v2
  systems get a REST adapter (Redox-style) outside this system. Implication:
  push is polling-with-diff (minutes-level latency — acceptable for scheduling
  workflows); bulk reads are bounded by protocol limits that force server-side
  filtering.
- **LLM authors, engine executes.** Instead of a hand-built query DSL, CopilotKit
  (already integrated) writes the query code at **design time**, with the
  DataSource's API spec as context. The artifact is saved, versioned, and
  human-approved; a deterministic sandboxed executor runs it at runtime. The LLM
  is never in the execution loop for recurring paths (determinism, cost, PHI
  auditability). Conversational agent work may still query live via scoped tools.
- **Executor lives behind the task API** (canonical home), so every client gets
  identical behavior via `POST /queries/:id/execute`. The Electron client calls
  it; it does not embed its own copy. This also lets triggers run continuously
  server-side rather than only while a client is open.
- **One execution language for v1:** sandboxed JS with an injected, scoped
  `fetch`. JS-over-REST expresses queries against any HTTP API; no SQL/multi-
  language runtime unless a real need appears.

## Concepts

### DataSource

A registered external API: `{ id, name, baseUrl, auth, entityTypes }`. Auth
credentials live server-side only — never in query code, never in LLM context.
Per-project bindings (`TemplateConfig.dataSources`) declare which sources a
project may use and any field mappings.

### SavedQuery

```jsonc
{
  "id": "sq_7f3a...",
  "name": "patients-pending-surgery",
  "version": 3,                       // immutable versions; consumers pin one
  "sourceId": "ds_epic_fhir",
  "status": "approved",               // draft | approved | disabled — only approved executes
  "approvedBy": "user@practice.com",  // design-time human gate

  "inputs": { /* JSON Schema for bound parameters, e.g. searchTerm */ },

  "code": "export default async function run(ctx) { ... }",

  "outputSchema": {
    "ref":     { "entityType": "patient" },  // every row MUST carry a resource ref
    "display": ["name", "dob"],              // safe-to-render fields
    "fields":  { "name": "string", "dob": "date", "surgeryFlag": "boolean" }
  },

  "limits": { "timeoutMs": 10000, "maxFetches": 20, "maxRows": 200 }
}
```

### Code contract

A single default-exported async function:

```js
// ctx.fetch  — ONLY I/O. Scoped to the DataSource baseUrl; creds injected by the
//              executor; read-only (GET) by default.
// ctx.inputs — validated against the inputs schema.
// Returns { rows: [{ ref: {sourceId, entityType, externalId}, ...fields }] }
export default async function run(ctx) {
  const res = await ctx.fetch(`/Patient?name=${enc(ctx.inputs.searchTerm)}&_count=50`);
  const bundle = await res.json();
  return { rows: bundle.entry.map(e => ({
    ref: { entityType: "patient", externalId: e.resource.id },
    name: fmtName(e.resource.name), dob: e.resource.birthDate
  })) };
}
```

Protocol rules and why:

- **`ctx.fetch` is the only I/O.** No ambient network/fs/timers. This one line is
  the security model: LLM-authored code can do anything *within* a read-only,
  base-URL-scoped, credential-injected fetch.
- **Read-only.** Mutating the source is a different artifact class (`SavedAction`,
  future) with its own approval gate. Queries never POST.
- **Every row carries a `ref`** (`{sourceId, entityType, externalId}`). Selections
  store the ref; triggers bind the ref into task `data` as placeholder keys (per
  the data-field contract); agents re-fetch live via the ref. Display fields are
  ephemeral snapshots.
- **`outputSchema` is declared, not inferred.** Forms know columns and triggers
  know condition fields without executing. Executor validates rows against it and
  fails loudly on drift (catches upstream API changes).
- **Immutable versions + approval.** Consumers pin `sq_x@vN`; an LLM-proposed vN+1
  changes nothing until approved. Audit answer: "exactly this code, version N,
  approved by X on date D, ran K times."
- **Limits enforced by the executor** (timeout, fetch count, row cap) bound bad
  code and structurally force server-side filtering.

### Executor

Sandboxed JS runtime (V8 isolate / worker): no fs, no ambient network, only the
injected `ctx`. Two modes over the same artifact:

- `execute(sq, inputs) → rows` — selectors, on-demand.
- `poll(sq, inputs) → { added, removed, changed }` — triggers. Executor keeps a
  hash of last-run `ref`s per (query, trigger) and diffs; dedup/idempotency lives
  in the platform, not per-query code.

#### Executor implementation (2026-07-02)

The v1 executor lives in the task API: `app/utils/query_executor.py` (Python) +
`app/utils/_query_harness.cjs` (the JS runtime), reached via
`POST /chromeext/queries/{id}/execute`.

**Sandbox choice: a Node subprocess running a `vm`-context harness.** Deno (the
design's preferred option — its `--allow-net` allowlist would scope network to the
DataSource host directly) is **not installed** on the deployment host; only Node
(v22.12) is. So each execution spawns one Node subprocess that runs the query
`code` in a `vm` context whose global object is **empty** (`Object.create(null)`):
no `require`, no `process`, no ambient `fetch`, no `Buffer`, no timers, and dynamic
`import()` is structurally dead (no `importModuleDynamically` callback →
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). The constructor-constructor escape stays
*inside* that context (`process` is still `undefined` there). The **only** capability
the code reaches is the injected `ctx` — so `ctx.fetch` is the single I/O path:
GET-only, scoped to `base_url` by origin **and** path prefix (an absolute URL,
`//other`, or `../` climb is refused), credentials injected server-side and never
visible to the code, and counted against `maxFetches`. Node is launched under
`--experimental-permission --allow-fs-read=<harness>` so fs-write / child-process /
worker are denied by the OS permission model as defense-in-depth (Node 22 has no
`--allow-net`, so network is bounded by the vm boundary, not a flag). `timeoutMs`
is a hard wall-clock subprocess kill; `maxRows` and output_schema/ref validation
(with `ref.sourceId` stamped by the executor) run on the Python side and fail
loudly on drift. If Deno is later installed, the harness can move to Option A for a
kernel-enforced net allowlist; the Python contract (validate → run → validate/stamp)
is unchanged.

### Consumers

1. **Form selectors.** `TemplateField.source` gains `{ savedQueryId, version }`
   (replacing the bare `agentFetchable` boolean / `tryAgentFetch()` stub in
   `NewTaskModal.tsx`). Field renders as a typeahead calling
   `execute` with the typed term; selection stores the `ref` + display snapshot.
   The modal-scoped Copilot action path (`fill_field` in `NewTaskCopilotChat.tsx`)
   gains a sibling `lookup_record` action that runs the same query — one lookup,
   two UIs.
2. **Trigger rules.** Per-project `TriggerRule`:
   `{ savedQueryId, version, condition, chainId, schedule }`. On `poll` diff,
   rows matching `condition` that have no existing instantiation marker fire the
   chain (`ChainDef` from templates+chains), binding the row's `ref` into each
   generated task's `data` field. Instantiation marker recorded to guarantee
   idempotency across polling cycles.

#### Poll/trigger engine implementation (2026-07-02)

`app/utils/query_poll.py` + `app/routers/triggers.py` (task API). `poll()` reuses
the executor for row production and diffs ref-hashes against a per-`(trigger,
query-family)` snapshot (hashes only, never row values). `condition` is a fixed
declarative `{field, op, value}` predicate (op allowlist eq/ne/gt/lt/gte/lte/
truthy/falsy/contains; **never eval'd**). A minimal server-side **Chain** = ordered
`{title_template, body_template, human_gate}` steps (JSON `chains` table); a
**TriggerRule** binds a SavedQuery version + condition + chain + interval
`schedule_secs`. On a cycle, each added/changed row satisfying the condition with
no marker instantiates the chain as ordered tasks (`depends_on`, container
`parent_task_id`), the row's ref bound into each task's `data` as `trigger.ref`
(JSON-encoded, encrypted at rest). **Idempotency** is a `(trigger_id, ref_hash)`
ledger, reserved before task creation in one `BEGIN IMMEDIATE` txn — a ref fires
exactly once, ever. **Scheduling** is CLI-invoked (`python app/utils/query_poll.py
run-due`, no in-process scheduler dep); deploy via cron/systemd-timer.

v1 sign-off items (deliberate, revisit if needed): (a) the marker commits *before*
task creation, so a mid-instantiation crash permanently suppresses that ref
(chose "never fire twice" over retry; a partial chain is auditable). (b) No
create-time approval gate on the referenced query — the executor still refuses a
non-approved version at run time, so a trigger on a draft errors on run rather than
being rejected up front.

### Authoring flow (CopilotKit)

Admin describes the need in chat ("dropdown of patients with upcoming
surgeries"). Copilot, grounded with the DataSource API spec, drafts the
SavedQuery (code + outputSchema), runs it against a sandbox for sample results
shown inline, iterates, then the human approves → status `approved`, version
frozen.

## PHI boundary

Query results transit memory only. Persisted artifacts: the SavedQuery record
(code + schema — no patient data), refs/placeholder keys in task `data`, and
diff hashes. Display snapshots follow the same rules as task bodies
(`phiSensitive`: never to disk/logs/notifications).

## v1 slice

1. Server (task API): SavedQuery CRUD + versioning/approval, JS sandbox executor
   with `execute` mode, one DataSource registered (test FHIR sandbox).
2. Client: `TemplateField.source → savedQueryId`, typeahead in NewTaskModal via
   `POST /queries/:id/execute`, `lookup_record` Copilot action.
3. Then: `poll` mode + `TriggerRule` + chain instantiation with `data` binding.

Deferred: webhooks/subscriptions, `SavedAction` (write-back), SQL/native-FHIR
executors, no-code admin UI for sources/triggers (config-first for v1).

## Addendum (2026-07-02): org-shared artifacts + the FormExtension primitive

This addendum answers a broader framing of the same need: *"register an API
available to both CopilotKit and the client; let CopilotKit author custom form
behavior; and make whatever is authored available to the whole org, not just the
authoring user."* Two clarifications to the design above, both confirmed with the
product owner.

### 1. Sharing is a scope field, not a mechanism

The three authored artifacts — **DataSource**, **SavedQuery**, and the new
**FormExtension** below — are **first-class server records in the task API,
scoped `per-project` and shared org-wide on approval.** The client is a cache,
not a store. This makes org sharing free and is the whole answer to "available
to other users in the same org":

- Every artifact carries `projectId`. Every member of that project, on every
  machine, receives it by fetching the project config the client already fetches.
- The **approval gate doubles as the sharing gate.** `status: draft` → visible
  only to the author (private iteration). Human approval → `status: approved`,
  the version freezes AND the artifact becomes project-visible. There is no
  separate "publish" step; approve *is* publish.
- Credentials never ride the artifact — `DataSource.auth` is server-only and
  never enters LLM context or the client (unchanged from above).
- Scope decision: **per-project, not org-wide-all-projects** — an EHR query for
  one practice must not leak into unrelated projects. A future org-scoped tier
  can be added behind an explicit `scope` field if a real cross-project need
  appears.

The four Copilot authoring actions (`register_data_source`, `author_query`,
`author_form_extension`, plus `lookup_record`) are all `confirmedAction`s
(`src/copilot/actionKit.tsx`) — the human-in-the-loop approve/reject card IS the
design-time gate, and the moment a private draft becomes an org-shared,
immutable version.

**Implemented (server, task_manager_api `app/utils/saved_queries_db.py`).** Both
registries carry `project_id` + optional `group_id`. Sharing is expressed through
`group_id` — the SAME mechanism `chromeext` tasks already use — so "project
membership" maps to group membership (`can_see_data_source`/`can_see_query` gate
on `db.groups_for(principal)`). `project_id` is a scope tag/filter, leaving room
for a future org-wide tier (`project_id IS NULL` / an explicit `scope` column). A
`draft` SavedQuery is author-only regardless of `group_id`; `approve_query` flips
it to `approved`, at which point group members see it — approval IS publication.
`DataSource.auth` is encrypted at rest and stripped by `_ds_public`; only the
server-only `resolve_data_source_auth` decrypts it for the executor.

### 2. FormExtension — "custom form behavior" WITHOUT arbitrary DOM code

"CopilotKit creates custom JavaScript to add things to a form" must NOT become
LLM-authored React/DOM injected into a PHI-carrying form (XSS / PHI-exfil hole;
the Copilot runtime is already CORS-locked precisely because it is PHI-adjacent
— `electron/copilot/runtime.ts`). Instead a **FormExtension** is a *declarative
manifest + a sandboxed PURE logic function*, run in the SAME V8 isolate the
SavedQuery executor already provides:

```jsonc
{
  "id": "fx_...", "version": 2, "status": "approved",
  "projectId": "project-...",              // scope = org sharing (see §1)
  "appliesTo": { "template": "intake" },
  "fields": [                              // declarative; rendered by the client's
    { "key": "patient", "label": "Patient", "widget": "typeahead",
      "source": { "savedQueryId": "sq_patients", "version": 3 } }, // binds a SavedQuery
    { "key": "surgeryDate", "label": "Surgery date", "widget": "date" }
  ],
  "logic": "export default ({values, changed}) => ({ setVisible, setValue, setOptions, validate })",
  "limits": { "timeoutMs": 200 }           // pure by default: no ctx.fetch
}
```

`logic` receives `{values, changed}` and returns a **declarative effect object**
(`setValue` / `setVisible` / `setOptions` / `validate`) that the trusted client
interprets against widgets it already owns — the client never `eval`s markup.
This delivers dependent fields, computed values, dynamic option lists, and custom
validation with zero arbitrary-DOM risk and identical behavior on every machine.
When an extension needs live data it **binds a SavedQuery** rather than fetching
inline, so all I/O stays on the one audited, credential-injected path.

**Sequencing (confirmed):** ship the declarative typeahead
(`TemplateField.source → savedQueryId`, v1 slice above) FIRST — it is 80% of the
value, is already testable against the dummy `/people` API
(`task-6fcced694f19`), and de-risks the sandbox. Add FormExtension `logic` as a
fast-follow once the executor is hardened.
