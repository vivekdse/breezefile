# Connections: first-class external-service registrations

**Status:** design — supersedes the executor/server-execution parts of
[`saved-queries-design.md`](saved-queries-design.md) (server-side sandboxed
JS executor, `POST /queries/:id/execute`, server-generated default queries,
scheduled canary polling). The DataSource/SavedQuery/ref *vocabulary* in that
doc — registered external API, immutable versions, a row `ref`, snapshot vs
live re-fetch, the PHI/data-bag rules — carries forward; **execution moves
from server-sandbox to client-direct.**

**Related:** [`typebuild-data-field-contract.md`](typebuild-data-field-contract.md)
(the `data` bag rules Connections snapshot into), `electron/typebuild/task-data.ts`
and `electron/typebuild/user-vault.ts` (the credential-brokering model this
generalizes), `electron/sources/typebuild.ts` (MCP mount point), `src/components/newhome/types.ts`
(`TaskDefField.source`, being widened), `src/components/groups/GroupsPage.tsx`
and `src/components/SecretsPanel.tsx` (UI precedent).

**TypeBuild tasks:** design doc = `task-7f6e5c85c695`; registry UI =
`task-62a5b4324954`; operator tools = `task-df205c19d40c`; field binding +
snapshot = `task-8f27d842f14d`; server (registry + broker) =
`task-15b03af371a6`.

---

## A. Overview and the credential/data split

A **Connection** is a first-class, standalone registration of an external
service — QuickBooks, a scheduling API, an MCP server — independent of any
task, template, or field. You register it once; from then on, any authorized
operator session or any TaskDefField in scope can use it. This replaces the
"DataSource lives only to back a SavedQuery" framing: a Connection is a
citizen in its own right, and being bound into a field source is one of two
uses (§D), not the definition.

**The crux of the design is where things run.** Two paths, deliberately
different:

1. **Registration + credentials: client → SERVER.** The server
   (`general.typebuild.com` / `task_manager_api`) is the **credential vault
   and broker**. It stores the Connection record and its secrets centrally,
   scoped to a project or group, and hands a credential to an authorized
   client on demand, one value per call, never logged. Register once → every
   machine the user (or their group) works from can use it → rotating a
   credential happens in one place.
2. **Data: client → external API, DIRECT.** Once a client holds a brokered
   credential, it calls the external API **itself**, straight from the
   Electron main process (or the MCP-mounted subprocess). The response
   **never round-trips through `general.typebuild.com`.** The server is not
   a data proxy and does not execute queries — it never even needs network
   reachability to the external API. This is also why an on-prem/LAN-only
   API (a practice's local scheduling box with no public endpoint) works:
   the server only ever hands out a credential; the machine sitting on that
   LAN makes the actual call.

```
                         REGISTRATION + CREDENTIAL BROKERING
                         (client → server, every time)
   ┌──────────┐   register Connection    ┌──────────────────┐
   │  Client   │ ────────────────────────▶│ general.typebuild │
   │ (Electron)│   (spec, scope; creds     │      .com          │
   │           │    captured, sent once)   │  Connection registry│
   │           │◀──────────────────────────│  + credential VAULT │
   │           │   ConnectionSummary        └──────────────────┘
   │           │   (creds-stripped)                 ▲
   │           │                                     │
   │           │   at JOB START:                     │
   │           │   GET .../connections/:id/credential│
   │           │───────────────────────────────────▶│
   │           │◀──────────────────────────────────── one cred,
   │           │   { value }  (held in memory only)   one call
   └────┬──────┘
        │
        │  DATA PATH — DIRECT, no server hop
        │  (credential in memory/PTY env; response never
        │   touches general.typebuild.com)
        ▼
   ┌──────────────────┐
   │  External API      │   QuickBooks REST · scheduling REST · MCP server
   │  (cloud OR on-prem) │
   └──────────────────┘
```

The server's job ends at "here is a Connection record" and "here is one
credential value for this call." Every byte of the actual business data —
AR aging reports, patient-adjacent scheduling slots, whatever the external
API returns — flows client-to-API and back, never touching the task-API
server.

---

## B. The Connection record

```ts
/** Server-side canonical record. NEVER sent to the client verbatim —
 *  `credentials` lives only in the server vault. The client always receives
 *  ConnectionSummary (below). */
interface Connection {
  id: string;                 // "conn_<12hex>"
  name: string;                // human label, e.g. "QuickBooks (Acme Physical Therapy)"
  kind: 'mcp' | 'rest';
  /** kind:'mcp'  → the MCP server URL the client mounts directly.
   *  kind:'rest' → the REST API's base URL; call-specs (§E) are relative to it. */
  endpoint: string;

  /** How the shape of this service is known. Two ways to populate it — see
   *  ConnectionSpec below. Always server-normalized and hashed so drift
   *  (§F) is detectable without re-fetching on every call. */
  spec: ConnectionSpec;

  /** Server-vault-only. Opaque to the client; never appears in
   *  ConnectionSummary, never in a list/detail response, never logged.
   *  What's actually stored (API key, OAuth token+refresh, basic-auth pair,
   *  MCP bearer token, ...) is shape-specific and lives entirely server-side. */
  credentials: ConnectionCredentialRef;

  /** Sharing/visibility, same mechanism `saved-queries-design.md` already
   *  uses for DataSource/SavedQuery: a Connection is visible to whoever can
   *  see its project, and can additionally be scoped to one group within
   *  that project (org-shared-on-approval semantics don't apply here — there
   *  is no draft/approve gate for a Connection; scope IS the gate). */
  scope: { type: 'project'; projectId: string } | { type: 'group'; groupId: string };

  createdBy: string;           // principal
  createdAt: string;           // ISO
  updatedAt: string;           // ISO
  status: 'active' | 'needs_attention' | 'disabled';  // needs_attention set by drift (§F)
}

/** How the service's shape (available operations / OpenAPI paths / MCP tool
 *  list) is known. Both variants are SERVER-fetched-or-stored, normalized,
 *  and content-hashed — the hash is what versions a field binding pins to
 *  (§D.2) and what a re-fetch compares against to detect drift (§F). */
type ConnectionSpec =
  | {
      mode: 'live_url';
      /** OpenAPI/Swagger URL (kind:'rest') or MCP server descriptor URL
       *  (kind:'mcp'). Server fetches this, normalizes it into `normalized`,
       *  and re-fetches on demand (§F), never automatically. */
      specUrl: string;
      normalized: unknown;      // server-normalized OpenAPI doc / MCP tool list
      hash: string;              // sha256 of the normalized form
      fetchedAt: string;         // ISO
    }
  | {
      mode: 'inline';
      /** Pasted OpenAPI JSON/YAML (kind:'rest') or a hand-authored tool
       *  manifest (kind:'mcp'), for services with no discoverable spec URL.
       *  Same hash/normalize treatment as live_url so the two modes are
       *  interchangeable everywhere else in the system. */
      raw: string;
      normalized: unknown;
      hash: string;
      fetchedAt: string;         // ISO — time of paste/normalize, not "live"
    };

/** Opaque server-side pointer into the vault. The client never sees the
 *  credential shape, only that one exists. */
interface ConnectionCredentialRef {
  vaultKey: string;             // server-internal; opaque to every client
  kind: 'api_key' | 'oauth2' | 'basic' | 'bearer' | 'mcp_token';
  /** Non-secret metadata safe to show in UI, e.g. OAuth expiry, last-rotated
   *  date, connected account email. NEVER a secret value. */
  display?: Record<string, string>;
}
```

### `ConnectionSummary` — the creds-stripped public projection

This is what every list/detail response actually returns to a client. It has
no `credentials` field at all — not stripped-at-serialize-time as a security
belt, but genuinely never selected off the vault table into this shape.

```ts
interface ConnectionSummary {
  id: string;
  name: string;
  kind: 'mcp' | 'rest';
  endpoint: string;
  spec: {
    mode: 'live_url' | 'inline';
    hash: string;
    fetchedAt: string;
    specUrl?: string;           // only when mode === 'live_url'
  };
  scope: Connection['scope'];
  status: Connection['status'];
  /** Non-secret display metadata copied from ConnectionCredentialRef.display
   *  (e.g. "connected as billing@acme.com", "expires 2026-09-01"). Lets the
   *  registry UI show "connected" state without ever touching a secret. */
  credentialDisplay?: Record<string, string>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

`GET /chromeext/connections` and `GET /chromeext/connections/:id` both return
`ConnectionSummary` (list / one). Neither ever returns `normalized` spec body
inline on the list call (it can be large) — list carries the hash only;
detail includes `normalized` for the registry UI's "what can this do"
inspector.

---

## C. Credential brokering

This mirrors the existing **class-2 "me.\*" entity resolver** exactly
(`electron/typebuild/task-data.ts`, `electron/typebuild/user-vault.ts`): a
per-scope vault, one value resolved per call, Firebase-authed, never cached
beyond the requesting process's lifetime, never logged. Connections are a
**new, third resolution class** alongside per-task PHI (class 1) and the
user's own vault (class 2) — scoped to a Connection + the caller's
membership in its project/group, not to a task or to "me."

### The handshake

At **job start** (the same pre-spawn waterfall in
`electron/sources/typebuild.ts` that already mints the MCP token and resolves
class-1/class-2 refs before the PTY spawns — see the `mintMcpToken` /
pre-spawn comments around L3300–L3390), the client:

1. Determines the **in-scope Connections** for this job — every Connection
   whose `scope` resolves to a project/group the launching task belongs to.
2. Calls the credential-broker endpoint **once per in-scope Connection**,
   exactly like the entity resolver's one-field-per-call discipline.
3. Holds each resolved credential in **client process memory only** — never
   written to disk, never logged, never placed in argv (mirrors
   `MCP_TOKEN_ENV`: PTY **env**, not `--mcp-config` argv text, so
   `/proc/<pid>/cmdline` never carries it).
4. **Re-fetches every job.** No credential is cached across job launches —
   same "never lingers beyond the request that needs it" discipline
   `task-data.ts` states for class-1/2 values. A revoked or rotated
   credential takes effect on the very next job, with zero client-side
   invalidation logic needed.

### Endpoint contract

```
GET /chromeext/connections/:id/credential
Authorization: Bearer <Firebase ID token>
Accept: application/json
```

- **One credential per call, never the vault record.** Mirrors §3 of the
  data-field contract: this endpoint returns exactly the material needed to
  authenticate to `:id`'s `endpoint` — never `Connection.credentials`, never
  a bag of every Connection the caller can see.
- **Scope-checked.** The caller must be a member of the project/group the
  Connection's `scope` names, exactly the same check that already gates
  Connection visibility in list/detail. A caller who can see the
  `ConnectionSummary` but has lost scope membership since (e.g. removed from
  the group) gets `403`.
- **Auth:** Firebase ID token Bearer — identical to every other
  `/chromeext/*` call (`typebuildFetch`'s existing 401-retry-once
  discipline applies unchanged).
- **The value MUST NEVER be logged**, echoed in an error, or returned by any
  list/detail/search endpoint. Only this endpoint, only in the `200` body.

### Responses

| Status | Body | When |
|--------|------|------|
| **200** | `{ "kind": "api_key", "value": "<secret>" }` or `{ "kind": "oauth2", "accessToken": "<token>", "tokenType": "Bearer" }` etc. — shape keyed by `ConnectionCredentialRef.kind` | Caller is in scope and the Connection has a live credential |
| **401** | `{ "error": "...", "reason": "unauthenticated" }` | Missing/invalid/expired Firebase token (client retries once with a fresh token, same as `typebuildFetch`) |
| **403** | `{ "error": "...", "reason": "not_in_scope" }` | Authenticated, Connection visible, but caller isn't in its project/group scope |
| **404** | `{ "error": "...", "reason": "not_found" }` | Connection doesn't exist / isn't visible to caller |
| **409** | `{ "error": "...", "reason": "credential_missing" }` | Connection registered but never had credentials captured (registry UI should have blocked this state, but the broker still guards it) |

Response shape is intentionally **not** a flat `{ value: string }` like the
class-1/2 endpoints — a Connection credential can be a bearer token, an
OAuth pair, or a basic-auth pair, and the caller (the client-direct executor,
§E, or the MCP mount, §D.1) needs to know which header/param shape to apply
it as. The one-value-crosses-one-hop, never-logged discipline is identical;
only the payload shape differs from the single-string class-1/2 case.

### Write path

Credentials are **set only at registration/edit time**, through the registry
itself — never through the broker endpoint, and never returned by it in
reverse:

```
POST /chromeext/connections
{ "name": "...", "kind": "rest", "endpoint": "...", "spec": {...},
  "credential": { "kind": "api_key", "value": "<secret, POST-only>" },
  "scope": { "type": "project", "projectId": "..." } }
→ 201 ConnectionSummary   // credential is written to the vault and NEVER echoed back

PATCH /chromeext/connections/:id
{ "credential": { "kind": "api_key", "value": "<new secret>" } }
→ 200 ConnectionSummary   // full credential replace, same "PATCH data = full
                          // replace" discipline as the task data-field contract
```

`credential` never appears in the response body of any registry call — POST
and PATCH both return `ConnectionSummary`, which structurally cannot carry
it. This is the same shape discipline `SecretsPanel`/`user-vault.ts` already
lean on (`PUT .../fields` returns `{ ok, id, field }`, never the value).

---

## D. Two uses of a Connection

### D.1 Ambient operator ability (no input field)

At job start, every in-scope Connection becomes a **tool the agent can call
directly** — no TaskDefField, no form, no binding. This is the "get me the
AR aging report" case: the operator asks in chat, the agent reaches for the
QuickBooks Connection's tool, calls it, and answers. Two distinct mounting
paths by `kind` — **no wrapping one as the other**:

**`kind: 'mcp'`** — mounted as an MCP server in the agent launch config,
exactly like the existing `typebuild` MCP mount
(`electron/sources/typebuild.ts` `MCP_INLINE_CONFIG`, ~L153–166, and the
`--strict-mcp-config --mcp-config <inline JSON>` spawn args ~L3576–3587).
Today that inline config has one entry (`typebuild`, header-authed with the
minted MCP token from `MCP_TOKEN_ENV`). Mounting a Connection extends the
same `mcpServers` map with one entry per in-scope `kind:'mcp'` Connection:

```ts
// Extending MCP_INLINE_CONFIG's mcpServers map, one entry per in-scope
// kind:'mcp' Connection. Each Connection gets its OWN env var name so
// multiple mounted MCP Connections never collide.
{
  mcpServers: {
    typebuild: { /* unchanged */ },
    [`conn_${connection.id}`]: {
      type: 'http',
      url: connection.endpoint,          // the Connection's MCP server URL
      headers: {
        Authorization: `Bearer \${CONN_${connection.id}_TOKEN}`,
      },
    },
  },
}
```

The credential (brokered per §C) is injected as `CONN_<id>_TOKEN` into the
spawned process's **env**, never into the argv-visible config string itself
— identical to how `MCP_TOKEN_ENV` keeps the TypeBuild MCP token out of
`/proc/<pid>/cmdline` today. `--strict-mcp-config` still applies: only
explicitly mounted servers load, so an out-of-scope Connection is never
reachable even if the agent tried to reference it by URL.

**`kind: 'rest'`** — **not** wrapped into a synthetic single-tool MCP server.
Instead the client exposes a **distinct declarative REST tool type**
directly to the agent (via the same tool-injection surface the client
already uses for its own built-in tools, not MCP at all): the tool's
input schema is derived from the Connection's `spec` (available
operations/paths from the normalized OpenAPI doc), and invoking it runs the
declarative call (§E) client-direct, with the brokered credential applied as
a header/query/body param per the credential `kind`. The response is handed
back to the agent as the tool result — still never touching
`general.typebuild.com`.

**Worked example (QuickBooks, `kind:'rest'`):** the operator types "get me
the AR aging report." The client's tool-injection layer has already, at job
start, turned the QuickBooks Connection's `GET /reports/AgedReceivables`
operation into a callable tool (name derived from the OpenAPI operationId).
The agent calls it with no bound field anywhere in the task; the client
resolves `{connection: quickbooks, method: GET, path: /reports/AgedReceivables}`
against the brokered OAuth token, calls QuickBooks directly, and returns the
JSON report to the agent's context.

### D.2 Field source (special case)

`TaskDefField.source` (`src/components/newhome/types.ts`, currently
`{ savedQueryId: string; version?: number; entityType?: string }`) widens to
reference a Connection instead of a standalone SavedQuery:

```ts
export type TaskDefField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'bool';
  options?: string[];
  required?: boolean;
  /** Widened: a field backed by a live external lookup now names a
   *  Connection + a declarative lookup operation, not a standalone
   *  SavedQuery id. `connectionVersion` pins the spec hash the binding was
   *  authored/approved against (mirrors SavedQuery's immutable-version
   *  pinning) — a later spec change flips the Connection to
   *  'needs_attention' (§F) rather than silently changing this field's
   *  behavior underneath an in-flight task. */
  source?: {
    connectionId: string;
    connectionVersion: string;      // the spec `hash` this binding was approved against
    lookup: CallSpec;                // declarative lookup call, §E — must produce `rows`
    /** Which of the returned row's declared fields get snapshotted into the
     *  task data bag on selection, and under what key. 'all' snapshots every
     *  field the lookup's output mapping declares. */
    bundle: { fields: Array<{ from: string; key: string }> } | 'all';
  };
};
```

**Flow (scheduling-API worked example):** a template field "Appointment
slot" binds `source: { connectionId: 'conn_sched', connectionVersion: 'a1b2...',
lookup: { method: 'GET', path: '/slots', query: { q: '{term}' }, output: { rows: '$.results[*]', ref: {...}, fields: {...} } }, bundle: 'all' }`.

1. **Typeahead.** As the user types, the client runs the declarative lookup
   client-direct (§E) against the scheduling API, using the brokered
   Connection credential — no server round-trip for the data itself, same
   split as §A.
2. **Selection.** The user picks a row. Each row already carries
   `ref: { connectionId, entityType, externalId }` (the same shape
   `saved-queries-design.md` established for `{sourceId, entityType,
   externalId}`, renamed `sourceId → connectionId`).
3. **Snapshot into the task `data` bag.** Per the bundle map, the row's
   declared fields are written as `<fieldKey>.*` sibling keys in the flat
   `string → string` data bag (`typebuild-data-field-contract.md` §1):
   `appt.slot_id`, `appt.start_time`, `appt.provider_name`, etc. — following
   the existing `<key>` + `<key>.ref` convention (a display value at the bare
   key, the resource pointer at `<key>.ref`). Structured field values
   (e.g. a nested object) are JSON-encoded into their string slot per the
   bag's existing rule; the consumer parses. `<fieldKey>.ref` is written as
   `JSON.stringify(ref)`.
4. **Provenance.** Two more sibling keys are written alongside the snapshot:
   `<fieldKey>.connection_id` and `<fieldKey>.connection_version` (+
   `<fieldKey>.picked_at`, ISO timestamp) — "exactly this Connection, this
   spec version, picked at this time" is the audit answer, mirroring
   SavedQuery's "exactly this code, version N, approved by X" story.

**Reserving the future lazy/fresh-at-execution mode.** Today's snapshot is
eager: the whole row is captured at selection time and never re-fetched.
A future mode where an agent re-fetches the field's value fresh at execution
time (rather than trusting the snapshot) is a **new ref class** in
`task-data.ts`'s resolver — analogous to how class-1 (per-task PHI) and
class-2 (`me.*` vault) are distinguished by ref prefix. A `conn.<connectionId>.<key>`
prefix (parallel to `me.`) would route the resolver to re-run the bound
`lookup`/a point lookup by `externalId` against the live Connection instead
of reading the task bag — **no schema rework needed**, because the snapshot
already stores everything (`connectionId`, `ref.externalId`) the lazy path
would need to re-resolve. This mode is explicitly deferred, not built now.

---

## E. Declarative execution schema

A REST call — whether an ambient tool invocation (§D.1) or a field-source
lookup (§D.2) — is a **declarative mapping**, never arbitrary code running in
Electron. (This is the one deliberate divergence from `saved-queries-design.md`'s
"LLM writes JS, sandboxed executor runs it" model: with execution moving
client-side, there is no sandboxed JS runtime to trust, so the call itself
must be inert data. See §G for what this drops.)

```ts
/** A single declarative REST call. No code — every dynamic part is a named
 *  slot filled from typed inputs, resolved client-side, applied to a plain
 *  HTTP request. */
interface CallSpec {
  method: 'GET' | 'POST';        // POST reserved for a future write-back class; queries are GET
  /** Path relative to the Connection's `endpoint`, with `{param}` slots,
   *  e.g. "/customers/{id}/invoices". */
  path: string;
  /** Slot values. Keys matching a `{param}` in `path` fill the path template;
   *  any others become query-string params. Values are either a literal or
   *  `"{inputKey}"` referencing a caller-supplied input (the typed search
   *  term, a selected filter, ...). */
  query?: Record<string, string>;
  headers?: Record<string, string>;   // static only — auth is injected separately from the broker
  body?: Record<string, unknown>;      // POST only; same {inputKey} substitution

  /** How to turn the HTTP response into rows/fields. */
  output: CallOutputMapping;

  limits?: { timeoutMs?: number };     // client-enforced; default e.g. 10000
}

/** JSON-path–based output mapping. */
type CallOutputMapping =
  | {
      /** Lookup shape — used for field-source typeaheads (§D.2). Must
       *  produce a `ref` per row so selections are durable pointers, not
       *  just display strings — same requirement saved-queries-design.md
       *  placed on SavedQuery.outputSchema.ref. */
      shape: 'rows';
      rowsPath: string;                          // JSON-path to the array, e.g. "$.results[*]"
      ref: { entityType: string; externalIdPath: string };  // JSON-path per row → externalId
      fields: Record<string, string>;             // fieldKey -> JSON-path (relative to each row)
    }
  | {
      /** Ambient-call shape — used for operator tool calls (§D.1) with no
       *  row/ref structure, e.g. a single report object. */
      shape: 'value';
      fields: Record<string, string>;             // fieldKey -> JSON-path (relative to response root)
    };
```

**MCP Connections need no `CallSpec`.** An MCP server defines its own tools
(names, input schemas, execution) on the server side; the client's job is
only to mount it (§D.1) and broker the credential into its env — there is no
client-side declarative mapping to author because the MCP protocol already
carries that contract.

---

## F. Drift (client-side, best-effort — no server sweep)

Unlike `saved-queries-design.md`'s server-side scheduled canary polling (a
process that proactively re-runs saved queries to catch upstream breakage),
Connections detect drift **only reactively, at call time, client-side**:

- A call that **fails outright** (non-2xx, timeout, connection refused) or
  **returns a shape that violates the declared `output` mapping** (a
  `rowsPath`/`fields` JSON-path that resolves to nothing where the mapping
  expects a value) flags the Connection **`needs_attention`** at that moment
  — no background sweep, no scheduled job. The next successful call clears
  the flag.
- **Spec re-fetch is on-demand, not automatic.** The registry UI offers a
  "re-check spec" action that re-fetches `specUrl` (or re-parses a pasted
  `inline` spec), re-normalizes, and re-hashes. If the hash changed, the UI
  shows a diff of affected operations/fields.
- **A changed declarative mapping requires human re-approval.** If a
  `CallSpec` (a field-source `lookup`, or an ambient tool's generated
  mapping) no longer matches the re-fetched spec, the client does **not**
  silently adapt it — a human reviews and re-approves the updated mapping,
  the same design-time gate `saved-queries-design.md` used for SavedQuery
  versions, just moved to "re-approve this mapping" instead of "approve this
  code."
- **Versioning protects in-flight tasks.** A field binding pins
  `connectionVersion` (the spec hash at authoring time, §D.2). A task created
  under version N keeps working against that pinned understanding even if
  the Connection's live spec moves to N+1 — the binding doesn't silently
  start using a different mapping mid-flight; only newly authored/edited
  bindings pick up the new version.
- **Semantic drift is explicitly out of scope for automated detection.** A
  response that is the *right shape* but now means something different
  (e.g. a scheduling API silently changes what "confirmed" means without
  changing its JSON shape) cannot be caught by shape validation. The
  mitigation is **provenance, not detection**: `<fieldKey>.connection_version`
  and `.picked_at` (§D.2) let a human trace exactly which spec version and
  moment produced a given snapshot value if something looks wrong downstream
  — human-in-the-loop is the only defense this design offers for semantic
  drift, by design.

---

## G. Server vs. client responsibility

| | Server (`task_manager_api`) | Client (breezefile) |
|---|---|---|
| **Owns** | Connection registry CRUD, scope enforcement (project/group visibility), spec store + on-demand fetch/normalize/hash, credential vault + broker endpoint | Credential-capture UI, mounting tools (MCP servers into launch config; REST tools into agent tool surface), declarative call execution (`CallSpec` → HTTP), field binding + typeahead + snapshot into task `data`, drift detection at call time |
| **Never does** | Execute any call against the external API; see or proxy any external-API response; run agent-facing tool calls | Store credentials at rest; run arbitrary/LLM-authored code to make a call |

**Explicitly no longer server work**, superseding the corresponding pieces
of `saved-queries-design.md`:

- **The sandboxed JS executor** (`app/utils/query_executor.py` +
  `_query_harness.cjs`, the Node `vm`-context sandbox) — there is no code to
  sandbox; `CallSpec` is inert data the client interprets.
- **`POST /queries/:id/execute` as a data proxy** — the server never sees
  query results; `GET .../connections/:id/credential` replaces it as the
  only per-call server hit, and it returns a credential, not data.
- **Server-generated default queries / LLM-authored `code` artifacts** — no
  code artifact exists to author; the registry UI (§H) authors a `CallSpec`
  directly, or a human just registers the Connection and lets typeahead
  build the lookup shape from the OpenAPI operation picked.
- **Scheduled canary polling** (`query_poll.py`'s proactive drift sweep) —
  replaced by reactive, call-time drift flagging (§F); no background job.

The **poll/trigger engine** (`TriggerRule`, chain instantiation on a row
diff) from `saved-queries-design.md` is **not addressed by this doc** — it
assumed server-side execution to poll without a client open. Whether/how
triggers work against client-direct Connections (e.g. requiring at least one
client online, or a future server-side execution carve-out specifically for
triggers) is an open question for a later design, not resolved here.

---

## H. Verb + UI

A new **`:connections`** verb (aliases: `connection`, `services`, `apis` —
mirroring the `:groups` verb's alias list in `ChipPrompt.tsx`) opens the
Connections management surface: registry list, create/edit, credential
capture.

- **Design system:** must use `src/styles/tokens.css` — no ad hoc colors/
  spacing, consistent with every other panel in the app.
- **Structural precedent:** two existing surfaces to mirror, one for layout
  and one for the credential-capture interaction:
  - `src/components/groups/GroupsPage.tsx` — master-detail: a left rail
    listing every Connection the user can see (name, kind badge, status
    chip mapping to `active`/`needs_attention`/`disabled`), a right pane
    showing the selected Connection's detail (endpoint, spec summary,
    scope, credential display metadata, re-check-spec action) plus a
    "+ New connection" flow.
  - `src/components/SecretsPanel.tsx` — the credential-capture interaction:
    masked-by-default fields, reveal-one-at-a-time semantics are the right
    model for *editing* a credential (you never round-trip the existing
    secret back to the client to show it — same as `SecretsPanel`'s
    write-only `PUT`-only fields), and its searchable-row / keyboard-nav
    pattern is the right feel for a growing Connection list.
- **Panel vs. full tab — recommendation: panel (SecretsPanel-style), not a
  full-screen tab (GroupsPage-style).** Rationale: registering a Connection
  is a credential-entry task — the same category of interaction
  `SecretsPanel` already owns for the vault and saved logins, and users will
  likely open it briefly (register, capture a credential, close) rather than
  live in it the way GroupsPage's team-roster browsing implies. A modal
  overlay keeps it consistent with the vault it is conceptually a sibling
  of. (GroupsPage's full-tab treatment fits because team management is
  browsed at length with a lot of simultaneous state — member tables,
  invites, project lists — which a Connection registry doesn't need.)

---

## I. Build plan

Ordered client work items, plus the one server dependency:

1. **Design doc** (this file) — `task-7f6e5c85c695`.
2. **Server: registry + broker** (dependency, not this repo) —
   `task-15b03af371a6`: `Connection`/`ConnectionSummary` CRUD, scope
   enforcement, spec fetch/normalize/hash (`live_url` + `inline`), the
   credential vault, and `GET /chromeext/connections/:id/credential`. Client
   work below is blocked on this landing (or a stub/mock of it) to integrate
   against.
3. **Bridge + IPC wiring** — extend the `fm.typebuild.*` bridge namespace
   with `fm.typebuild.connections.*` (list, get, create, update,
   requestCredential-at-job-start — never a general reveal), preload
   exposure, and the main-process IPC handlers, following the exact shape
   `fm.typebuild.groups` and `fm.typebuild.vault` already establish.
4. **`:connections` verb** — register in `ChipPrompt.tsx` (alias list,
   dispatch a `fm:openConnections` event) and the corresponding open/close
   wiring in `App.tsx`, mirroring `fm:openGroups`.
5. **Registry + credential-capture UI** — `task-62a5b4324954`: the panel
   from §H (list, create/edit, credential capture, status/drift display,
   re-check-spec action).
6. **Operator-tool mounting** — `task-df205c19d40c`: extend
   `electron/sources/typebuild.ts`'s pre-spawn waterfall to (a) resolve
   in-scope Connections for the launching job, (b) broker each credential
   into a per-Connection PTY env var, (c) for `kind:'mcp'`, extend
   `MCP_INLINE_CONFIG.mcpServers` with one entry per Connection; (d) for
   `kind:'rest'`, register the derived declarative REST tools on the
   client's own agent-tool-injection surface and implement the `CallSpec`
   interpreter (§E) that executes them client-direct.
7. **Field binding + snapshot** — `task-8f27d842f14d`: widen
   `TaskDefField.source` (`src/components/newhome/types.ts`) to the
   Connection-based shape (§D.2), build/extend the typeahead component
   (successor to `SourceTypeahead.tsx`) to run a `CallSpec` lookup
   client-direct, and implement the row-selection → `data`-bag snapshot
   (bundle map → `<fieldKey>.*` sibling keys + provenance keys), per
   `typebuild-data-field-contract.md`.
8. **HelpTour update** — add a `:connections` row to the relevant catalog
   slide in `src/components/HelpTour.tsx` per the repo's standing rule
   ("whenever you ship a new feature or verb, update HelpTour").

Item 2 is the only cross-repo dependency; items 3–8 are sequential-ish within
this repo but 6 and 7 can proceed in parallel once 3–4 land, since ambient
tool-mounting and field-source binding share the broker (§C) and `CallSpec`
interpreter (§E) but touch disjoint UI surfaces.

---

## J. Admin-curated catalog + user authorization (the Okta model)

**Status:** shipped client-side 2026-07-11; server work filed as
`task-7c45ba74047e` (task_manager_api) depending on `task-ca51be2f261b`
(authkit).

§§A–I assume the person opening the panel both authors the Connection and
supplies its credential. Most users can't (and shouldn't) do that. This
section adds the layer above: an **ADMIN provisions the available
connections centrally**, and the end user's whole job is *select + authorize*
— Okta-style tiles. The manual registration path (§H) is retained but
demoted behind an "Advanced: register a custom connection" disclosure.

### J.1 Model

- A **catalog entry** is an admin-provisioned "this service is available to
  connect" record: `{ id, toolkit, name, description?, kind: 'rest'|'mcp',
  icon_url?, auth: 'oauth'|'admin_managed', scope? }`. It lives server-side
  (task_manager_api, backed by authkit's connector layer — Composio outbound
  OAuth with per-toolkit token vault). The client never authors catalog
  entries; admin provisioning is a server/authkit surface.
- `auth: 'oauth'` — each user authorizes their OWN account: Connect →
  authorize URL opens in the system browser → OAuth consent → the server
  vaults the token. `auth: 'admin_managed'` — the admin supplied one shared
  credential centrally; users see "Managed by your admin" and there is
  nothing to authorize or disconnect.
- `status` is **per-caller**: `available` → `pending` (authorize opened, not
  yet completed) → `connected` (+ `connected_as`, `connected_at`,
  `connection_id`).
- **On `connected` the server materializes a normal Connection record**
  (§B) whose credential resolves from the connector token vault as
  `kind:'oauth2'`. Everything downstream — the broker (§C), operator
  mounting (§D.1, including the MCP mount's oauth2→bearer mapping in
  `connection-mount.ts`), CallSpec execution (§E), field binding (§D.2) —
  works unchanged. The catalog is only a new way for a Connection to come
  into existence.

### J.2 Wire contract (client ↔ task_manager_api)

Same base + Firebase bearer auth as `/chromeext/connections`. All four
routes degrade gracefully client-side until deployed (list → `[]`, mutations
→ structured `{ok:false}`, status → `null`).

| Method | Path | Returns |
|---|---|---|
| GET | `/chromeext/connections/catalog` | `{ catalog: [entry] }` — entry as J.1, snake_case, plus per-caller `status`, `connection_id?`, `connected_as?`, `connected_at?` |
| POST | `/chromeext/connections/catalog/:entryId/connect` | `{ redirect_url?, connection_id?, status }` — `redirect_url` is the OAuth authorize URL; structured error on 403/404/409 |
| GET | `/chromeext/connections/catalog/:entryId/status` | `{ status, connected_as?, connection_id? }` — polled while pending |
| DELETE | `/chromeext/connections/catalog/:entryId/connection` | 200/204 — disconnects the CALLER's connection for that entry |

### J.3 Client flow (shipped)

`ConnectionsPanel` leads with **Available connections** (catalog tiles):
Connect → `catalog.connect(id)` → open `redirectUrl` via the system browser
→ tile flips to "Waiting for authorization…" → poll `catalog.status(id)`
every 3s for up to 3 minutes → on `connected`, refresh both the catalog and
the registered list; on timeout, revert with a retry hint. Connected oauth
entries get Disconnect (confirm-inline, like delete); `admin_managed`
entries show "Managed by your admin" with no actions. **Your connections**
(the §H registry list) follows, and the §H create/edit form sits behind the
Advanced disclosure. Wire layer: `electron/sources/typebuild.ts`
(`listConnectionCatalog` / `connectCatalogEntry` / `getCatalogEntryStatus` /
`disconnectCatalogEntry`) → `ipc-connections.ts`
(`typebuild:connections:catalog:*`) → preload → `fm.typebuild.connections.catalog.*`.

### J.4 Server-side split (filed, not built)

- **authkit (`task-ca51be2f261b`):** the catalog registry table, admin-gated
  CRUD (platform-admin / group-admin), the caller-scoped catalog listing
  joined with per-user connector state, and closing the any-user-any-toolkit
  hole in `POST /connectors/{toolkit}/connect`.
- **task_manager_api (`task-7c45ba74047e`):** mount/adapt the authkit
  catalog to the J.2 routes, and materialize the Connection record on
  `connected` so the §C broker serves oauth2 credentials from the connector
  vault (force-refreshing expired tokens server-side).

### J.5 `first_party_mcp` (added 2026-07-12, server-led)

The server shipped a third auth mode beyond J.1's two:
`auth: 'first_party_mcp'` — a **first-party TypeBuild service** (first
instances: the Scheduler tiles pointing at `scheduling.typebuild.com`,
and — confirmed live 2026-07-14 — the Composio-backed connectors catalog
at `connectors.typebuild.com/mcp`, exposing `list_catalog`/
`list_connections`/`connect`/`poll`/`disconnect`/`list_actions`/
`describe_action`/`execute`/`call` for third-party services like Gmail
and Google Drive, each user authorizing their own account per J.1's
`auth:'oauth'` semantics one layer down inside that server).
Semantics:

- **Always `connected`** for every caller: no OAuth dance, no broker, no
  materialized Connection record. The catalog entry carries a new
  `service_url` field (client: `serviceUrl`) — the endpoint itself.
- **Mounting:** `kind:'mcp'` first-party entries are folded into the mount
  plan straight from the CATALOG (`connection-mount.ts`), with the
  `mcpServers` Authorization header referencing the already-injected
  minted-token env var (`TYPEBUILD_MCP_TOKEN`) — the user's existing
  TypeBuild identity is the credential, so no extra secret is plumbed.
  Entries may carry a J.1 scope; unscoped entries mount into every job.
  `kind:'rest'` first-party tiles are display-only for now — REST tool
  derivation needs a spec (§E), which catalog entries don't carry.
- **UI:** the tile shows Connected · "Included with your account", with no
  Connect/Disconnect actions.

### J.6 Client-direct first-party field sources (2026-07-12)

The "+ input" picker also lists first-party catalog tiles as field sources
(no SavedQuery, no server executor — §C client-direct all the way):

- `src/components/newhome/firstPartyLookups.mjs` holds per-toolkit lookup
  templates (the first: `scheduling-api` → "Scheduler · Patient name",
  business-scoped `/customers/search` with `{q}`). First-party services may
  ship their templates in the first-party client; third-party lookups are
  still authored per-binding or spec-derived.
- The picker (FieldKeyPicker) projects connected tiles through the same
  QueryCatalogEntry shape as SavedQuery fields; picking one resolves the
  caller's scope rows (e.g. `/businesses`, first row binds) and builds a
  §D.2 Connection-form field via `fieldFromConnection` with
  `connectionVersion: 'first-party'`.
- `lookupConnection` (main) resolves `cat-*` ids from the catalog (60s TTL
  cache) and executes against the tile's `serviceUrl` with the user's
  **Firebase ID token** as bearer — NOT the taskapi MCP mint, which is a
  different issuer and 401s. **Pending:** scheduling REST must accept
  Firebase ID tokens (task-875dbab9e106) — until then the typeahead
  degrades to no rows.
