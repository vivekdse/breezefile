# Scheduling API auth: how the client would reach scheduling.typebuild.com

**Status:** investigation — written to answer one question for
task-f074f5a0cd35 (the SavedQueries/Connections e2e-test epic): *can the
client mint a token today that scheduling.typebuild.com will accept?*
**Verdict up front: no — the client has no code path that talks to
scheduling.typebuild.com or auth.typebuild.com at all.** See §4.

This doc is grounded entirely in the client source as of 2026-07-11. Every
claim below cites a `file:line`. Where the task's premise didn't match what
the code does, that's called out explicitly rather than papered over.

**Related:** [`connections-design.md`](connections-design.md) (the actual,
separate mechanism this repo is building for external APIs like a scheduling
REST — client-direct calls brokered by server-vaulted credentials, NOT the
Firebase→AS flow this doc investigates).

---

## 1. The model (as given by the task; NOT yet wired into this client)

```
 ┌────────────┐  Google sign-in   ┌──────────────┐
 │  Breeze/    │ ───────────────▶ │   Firebase    │
 │  TypeBuild  │ ◀─────────────── │ (project      │
 │  client     │  Firebase ID tok │  ...465302)   │
 └─────┬──────┘                   └──────────────┘
       │ POST /mcp-token
       │ Authorization: Bearer <firebase id token>
       ▼
 ┌────────────────────┐   mints scoped    ┌─────────────────────────┐
 │ auth.typebuild.com  │ ────────────────▶ │  access_token (JWT)      │
 │  (central AS,        │   access_token   │  aud = ?, scope = ?      │
 │   mints, verifies    │                  └───────────┬──────────────┘
 │   nothing itself)    │                              │
 └─────────────────────┘                               │ Authorization: Bearer
                                                         ▼
                                          ┌───────────────────────────────┐
                                          │  scheduling.typebuild.com       │
                                          │  (PURE resource server —        │
                                          │   verifies aud/scope, mints      │
                                          │   nothing)                       │
                                          │  admin_router / customer_router /│
                                          │  webhook_router / public_router  │
                                          └───────────────────────────────┘
```

Live probes (from the task, not re-verified here — this doc is about the
client, not the server):
- `scheduling.typebuild.com/mcp` → 401 (server up, needs a token).
- `scheduling.typebuild.com/public/...` → 422 with no token (public route
  reachable, wants params, no auth).
- `auth.typebuild.com/mcp-token` → 401 without a Firebase token (mounted).

**What this client actually has today** is a *different* mint endpoint,
`https://general.typebuild.com/mcp-token` (electron/typebuild/mcp-token.ts:32),
not `auth.typebuild.com`. That endpoint mints a token for the TypeBuild task
MCP server itself (`general.typebuild.com`), for an embedded `claude` PTY
session — see §4. There is no code anywhere in this repo that references
`auth.typebuild.com` or `scheduling.typebuild.com` (grep across
`electron/` and `src/` returns zero hits for either string).

## 2. The four scheduling routers and which token each needs

This table is the server-side contract as given by the task (not verified
against server code — that repo is out of scope here per task instructions).
It's reproduced so the doc is self-contained for whoever wires up the client
side next.

| Router | Auth required | Scope | Client caller class |
|---|---|---|---|
| `admin_router` | AS-minted access token | `scheduling:admin` or `scheduling:staff` (config-writes admin-only) | Operator / admin session |
| `customer_router` | AS-minted access token | `require_customer` + `scheduling:book` | Signed-in customer session |
| `webhook_router` | Twilio request signature | n/a (no bearer token) | Not a client-initiated caller — inbound from Twilio |
| `public_router` (`/public/...`) | **none** | n/a | Any caller, no auth — e.g. `GET /public/businesses/{business_id}/availability/slots` |

The client, as it stands, has no code for any of the three token-bearing
rows. It could reach the `public_router` today with a plain unauthenticated
`fetch` (nothing scheduling-specific needed) — see §5.

## 3. What the client's existing Firebase/mint plumbing actually does

Three files carry the client's entire auth stack. None of them mention
scheduling.

### `electron/typebuild/auth.ts` — Firebase session lifecycle
- `signIn(email, password)` (auth.ts:224) — REST call to
  `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` (auth.ts:49,
  225) against Firebase project `vivekpersonal-1607716465302` (auth.ts:5-7).
  Firebase ID token held **in main-process memory only** (auth.ts:11,
  session.idToken at auth.ts:59-69); refresh token persisted **encrypted**
  via Electron `safeStorage` to `userData/typebuild-auth.bin`
  (auth.ts:99-122, `electronSafeStorageStore.save`).
- `adoptSession({idToken, refreshToken, email, expiresIn})` (auth.ts:267) —
  used by the browser sign-in flow (§below) to hand off tokens obtained via
  OAuth instead of email/password; stores them through the exact same
  lifecycle (auth.ts:257-265 doc comment).
- `getIdToken()` (auth.ts:354) — returns a valid ID token, auto-refreshing
  when within 5 minutes of expiry (`REFRESH_SKEW_MS`, auth.ts:55),
  single-flight across concurrent callers (auth.ts:360-366, `refreshInFlight`).
  This is the function any future scheduling client call would start from.
- `doRefresh()` (auth.ts:305) exchanges the refresh token via
  `securetoken.googleapis.com/v1/token` (auth.ts:51, 306) — standard Firebase
  secure-token refresh, independent of which flow (password or browser OAuth)
  originally produced the session (auth.ts:262-265).
- On refresh failure the session is dropped and the encrypted file cleared
  (auth.ts:316-320) — the "sign in again" path.

### `electron/typebuild/browser-signin.ts` — how the ID token is obtained interactively
- Drives the TypeBuild server's own OAuth 2.1 + PKCE flow (Dynamic Client
  Registration at `/register`, `/authorize` → hosted `/mcp-login` page,
  `/token` exchange) against `SERVER_BASE = 'https://general.typebuild.com'`
  (browser-signin.ts:55-58) — **not** a direct Google OAuth integration
  (browser-signin.ts:2-3).
- `signInViaBrowser()` (browser-signin.ts:242) opens a small in-app
  `BrowserWindow` (browser-signin.ts:185-206) pointed at `/authorize`, catches
  the redirect on a one-shot loopback listener (browser-signin.ts:257-421),
  then `completeExchange()` (browser-signin.ts:440) POSTs `/token` and reads
  `firebase_id_token` / `firebase_refresh_token` / `email` out of the
  response (browser-signin.ts:483-491) before calling `auth.adoptSession()`
  (browser-signin.ts:497).
- No `scope` parameter is sent to `/authorize` at all — the code comment is
  explicit that the server rejects unregistered scopes and "the MCP flow uses
  none" (browser-signin.ts:395-396). This is a second, independent signal
  (alongside §4) that nothing in this OAuth exchange requests a
  scheduling-specific scope or audience.

### `electron/typebuild/mcp-token.ts` — the ONLY token-exchange the client has
- `mintMcpToken()` (mcp-token.ts:78) is the sole "exchange a Firebase ID
  token for a downstream API token" function in the codebase.
- It calls `getIdToken()` from auth.ts (mcp-token.ts:29, 84) to get a fresh
  Firebase ID token, then:
  ```
  POST https://general.typebuild.com/mcp-token
  Authorization: Bearer <firebase id token>
  Content-Type: application/json
  body: { device_name: "breezefile (<hostname>)" }
  ```
  (mcp-token.ts:32, 98-105). The URL is `general.typebuild.com`, **not**
  `auth.typebuild.com`.
- The POST body is `{ device_name }` only (mcp-token.ts:104) — **no
  `resource`, `aud`, `audience`, or `scope` parameter is sent anywhere in
  this function.** This is the central fact for §4.
- Response handling: `{ access_token, expires_in }` on 200
  (mcp-token.ts:139-142); `expires_in` (seconds) converted to an absolute
  `expiresAt` epoch, falling back to an 8h TTL if omitted
  (mcp-token.ts:149-152). Typed errors: 401 → `signed-out` (and, for
  `invalid_token`, also force a local sign-out, mcp-token.ts:116-129), 403 →
  `access-denied` (mcp-token.ts:130-134), network/5xx → `unreachable`
  (mcp-token.ts:106-108, 135-136).
- The minted token is documented as **never logged, persisted, or returned to
  the renderer** — handed to exactly one caller (mcp-token.ts:24-26) — the
  session spawner in `electron/sources/typebuild.ts` (imported at
  typebuild.ts:65, used at typebuild.ts:3723-3848 to gate spawning an
  embedded `claude` PTY, with the token injected into that PTY's environment
  as `${TYPEBUILD_MCP_TOKEN}`, typebuild.ts:4071 / sessions.ts:4-6).

**What this token is for:** it authenticates an embedded Claude Code session
against the TypeBuild MCP server (`general.typebuild.com`) so the session
"starts already authenticated — no `/mcp` OAuth popup" (mcp-token.ts:3-5).
It is scoped, by construction, to TypeBuild's own MCP surface. Nothing about
its request or its consumption resembles the RFC 8707 resource-indicator
pattern needed to get a scheduling-audienced token.

### `electron/typebuild/ipc-auth.ts` — renderer access
- Exposes `typebuild:auth:signIn`, `typebuild:auth:signInBrowser`,
  `typebuild:auth:cancelBrowser`, `typebuild:auth:signOut`,
  `typebuild:auth:state`, and broadcasts `typebuild:auth:changed`
  (ipc-auth.ts:47-79). This is how a renderer-side feature (e.g. a future
  "Connect to scheduling" UI) would trigger sign-in — but it exposes only the
  Firebase session lifecycle, not `mintMcpToken` or any scheduling call.

## 4. ⚠ Integration gap: the audience question

**The task's central question — does the client's token exchange mint a
token whose `aud` equals `https://scheduling.typebuild.com/mcp`? — is
unanswerable in the affirmative, because the client makes no such exchange
at all.**

Concretely:

1. **Wrong (or rather, only) endpoint.** The client's one mint call targets
   `https://general.typebuild.com/mcp-token` (mcp-token.ts:32), not
   `https://auth.typebuild.com/mcp-token`. There is no client code that
   constructs a request to `auth.typebuild.com` anywhere in this repo
   (`grep -rn "auth.typebuild.com"` across `electron/` and `src/` → 0 hits).
2. **No resource/audience parameter, period.** The POST body sent to
   `/mcp-token` is exactly `{ device_name }` (mcp-token.ts:104). No `resource`,
   `aud`, or `audience` field is set, sent, or even modeled in the
   `MintedMcpToken` type (mcp-token.ts:40-44, which only carries `accessToken`
   and `expiresAt`). There is nothing to "line up" with
   `scheduling.typebuild.com/mcp` — the request doesn't attempt to request any
   particular audience.
3. **No scheduling call site.** `grep -rniE "scheduling|scheduling:"` across
   `electron/` and `src/` turns up only unrelated matches (a cron-scheduling
   comment in `electron/tasks.ts:34`, and UI copy in `HelpTour.tsx:458`/
   `TaskComposer.tsx:5712` that both talk about "scheduling" in the generic
   sense of a booking API as an *example* Connection, not a coded
   integration). There is no `fetch`/`http` call anywhere in the client aimed
   at `scheduling.typebuild.com`.

**Verdict: GAP — not "works", not "unclear". The client today has no code
path that could produce a token scoped for `scheduling.typebuild.com/mcp`,
because it never asks for one.**

What would need to change, and where:
- **Client change required** (this repo): a new function, most naturally a
  sibling of `mintMcpToken()` in `electron/typebuild/mcp-token.ts` (or a new
  `electron/typebuild/scheduling-token.ts`), that:
  - POSTs to `https://auth.typebuild.com/mcp-token` (not
    `general.typebuild.com` — that endpoint is TypeBuild-MCP-scoped by
    design, per its own doc comment at mcp-token.ts:1-5) with
    `Authorization: Bearer <firebase id token>` (reusing `getIdToken()` from
    auth.ts:354, exactly as `mintMcpToken` does at mcp-token.ts:84).
  - Sends a `resource` (RFC 8707) — or whatever field auth.typebuild.com
    actually expects; this needs confirming against the AS's contract, not
    assumed — set to `https://scheduling.typebuild.com/mcp` (or the exact
    audience string scheduling's gates check; the task states scheduling
    checks `aud == https://scheduling.typebuild.com/mcp` but that should be
    confirmed against scheduling's server code, which is out of scope for
    this client-side doc per the task's repo boundary).
- **Possibly also an AS-side confirmation** (not a client change, but a
  prerequisite the client change depends on, and out of scope to implement
  here): that `auth.typebuild.com/mcp-token` actually honors a `resource`
  parameter and mints a token whose `aud` claim reflects it, and that the
  route is scoped/keyed to the caller's `scheduling:*` permissions. This
  repo cannot verify that — it belongs to `auth.typebuild.com`'s own repo,
  not `breezefile`.
- This is the one precise gap the epic's e2e test needs to close before a
  scheduling Connection's admin/customer routers are reachable from this
  client. The public route (§5) needs none of this.

## 5. The zero-auth path: public availability slots

The one scheduling route the client (or literally anything) could call
**today, with no client-side auth code at all**, is the `public_router`
route named in the task:

```
GET https://scheduling.typebuild.com/public/businesses/{business_id}/availability/slots
```

No `Authorization` header, no Firebase session, no mint call — a plain
`fetch`. The live probe already run (per the task) got a 422 with no token,
i.e. the route is reachable and unauthenticated; it just wants query params
(likely a date range / service id) that weren't supplied. This is the
correct integration point for anything in this client that only needs
PII-stripped public slot availability (e.g. a public-facing booking widget)
and want not deal with §4's gap at all.

## 6. Token lifetime and refresh (for whichever token you're holding)

Two different tokens, two different lifetimes, both already handled by
existing code the scheduling work should reuse rather than reinvent:

- **Firebase ID token** (~1h TTL, auth.ts:16). Never persisted — main-process
  memory only (auth.ts:11, 59-69). `getIdToken()` (auth.ts:354) transparently
  refreshes when within 5 minutes of expiry (auth.ts:357, `REFRESH_SKEW_MS` =
  auth.ts:55) using the persisted refresh token, single-flight
  (auth.ts:360-366) so concurrent callers share one refresh round-trip. Any
  future scheduling call should call `getIdToken()` fresh each time it needs
  to mint/re-mint an AS token — never cache the ID token itself.
- **Firebase refresh token** (long-lived). The only thing persisted to disk,
  and only **encrypted** via Electron `safeStorage` to
  `userData/typebuild-auth.bin` (auth.ts:99-122). On `doRefresh()` failure
  (revoked/disabled) the session is dropped and the file wiped
  (auth.ts:316-320) — surfaced today as `McpTokenError('signed-out', ...)`
  for the existing MCP mint (mcp-token.ts:116-129); a scheduling mint should
  follow the identical pattern (re-mint the Firebase ID token, re-exchange,
  and on 401/`invalid_token` force sign-out so the UI shows sign-in again).
- **AS-minted access token** (existing `MintedMcpToken`, mcp-token.ts:38-44;
  a scheduling equivalent would look the same). `expiresAt` is derived from
  `expires_in` (seconds) at mint time, with an 8h fallback if the server
  omits it (mcp-token.ts:149-152). The existing token is documented as
  **never persisted, never logged, never returned to the renderer** — held
  only by the one caller that needs it, for the duration of that use
  (mcp-token.ts:24-26). A scheduling access token should follow the same
  rule: mint it just before the call(s) that need it, keep it in memory only,
  and re-mint (don't try to refresh an opaque AS access token) once it's
  within its own expiry skew — there is no client-side "refresh token" for
  an AS access token in this design; the Firebase ID token is what gets
  re-exchanged.

## 7. Naming note

This repo is mid-rename from **Breeze File** to the **TypeBuild client** (see
the repo's root `CLAUDE.md`). Readers of the files cited above will meet both
names side by side:
- User-facing / new code: `typebuild` — the directory
  `electron/typebuild/`, exports like `mintMcpToken`, `getIdToken`,
  `signInViaBrowser`, IPC channel prefix `typebuild:auth:*`.
- Legacy `breeze*` identifiers still in these exact files: the persisted
  auth file is `typebuild-auth.bin` but the OAuth client registers itself as
  `client_name: 'Breezefile'` (browser-signin.ts:130); the device label sent
  to `/mcp-token` is `` `breezefile (${hostname()})` `` (mcp-token.ts:36);
  UI strings in `browser-signin.ts`'s `resultPage()` say "Breezefile"
  (browser-signin.ts:213-229); comments throughout reference "bead
  fm-b5at.*" identifiers (e.g. auth.ts:1, mcp-token.ts doc header) which are
  this project's pre-TypeBuild-MCP issue-tracking IDs, now historical.
  None of this affects behavior — it's cosmetic naming debt already flagged
  in the repo's rename plan — but a reader building the scheduling
  integration should use `typebuild` naming for anything new and not be
  surprised to see `breeze`/`Breezefile` strings in the files they're
  extending.

## Verification performed

- Read `electron/typebuild/mcp-token.ts`, `auth.ts`, `browser-signin.ts`,
  `ipc-auth.ts`, `electron/typebuild/sessions.ts`, and the call site in
  `electron/sources/typebuild.ts` in full.
- Grepped the whole client tree (`electron/`, `src/`) for
  `scheduling`, `mcp-token`, `resolve_operator_scope`, `scheduling:`, and
  `auth.typebuild.com` — no scheduling integration code and no
  `auth.typebuild.com` reference exists anywhere in this repo today.
- Did **not** attempt a live end-to-end call. This client cannot originate an
  interactive Firebase/Google sign-in headlessly, and — more fundamentally —
  there is no code path in this repo that would even attempt to mint a
  scheduling-audienced token to try that call with. Nothing here should be
  read as "the flow works, just untested" — the flow, as scoped to
  scheduling, does not exist in the client yet. The **live 200 end-to-end is
  UNVERIFIED**, and per §4, the specific risk isn't just "didn't run it" —
  it's that the code to request the right audience hasn't been written.
- Did not read or touch any server repo (`task_manager_api` or others), per
  task scope.
