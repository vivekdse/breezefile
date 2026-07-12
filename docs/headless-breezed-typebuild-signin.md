# Headless breezed → TypeBuild sign-in on an external server

**Status:** investigation + how-to — written for TypeBuild task `task-f19c954b5f28`.
Grounded entirely in the client source as of 2026-07-12; every claim cites a
`file:line`.

**Verdict up front.** A **fully-headless** breezed daemon (no GUI, ssh only)
**can** authenticate to TypeBuild today — but **not** by transplanting a session
or forwarding a browser. The one working path is a **service credential**:
`TYPEBUILD_EMAIL` + `TYPEBUILD_PASSWORD` in the daemon's environment, which
`initHeadlessAuth()` feeds straight into the Firebase Identity Toolkit
email/password REST call — no Electron, no `BrowserWindow`, no keyring
(`electron/typebuild/auth.ts:442`, `:426`, `:224`; wired at
`daemon/breezed.ts:506`). Of the three candidate paths this task asked about:

| Path | Works today? | Why |
| --- | --- | --- |
| **A. Transplant the persisted refresh token** from a GUI box | **No** | `safeStorage` blob is per-OS-user/keyring — not portable; and there is no headless entry point that accepts a raw refresh token. |
| **B. ssh-forward the loopback OAuth callback** | **No** | The flow requires an Electron `BrowserWindow` and runs the token exchange in the same GUI process — headless breezed has neither. |
| **C. Provisioned daemon service credential (client_credentials)** | **Not built** | No such grant exists; presented below as a design proposal. |

The **actually-working** path (email/password env creds) is neither A, B, nor C
in the sense the task framed them — it is a *human* service account's
email/password, used headlessly. It is documented first, with copy-pasteable
steps.

---

## 0. What the daemon does today (the working path)

Headless breezed authenticates like this, end to end:

1. `daemon/breezed.ts:503` `startTypeBuildLoop()` calls
   `initHeadlessAuth()` (`daemon/breezed.ts:506`).
2. `initHeadlessAuth()` reads `TYPEBUILD_EMAIL` / `TYPEBUILD_PASSWORD` from the
   environment and, if both are present, calls `signInHeadless()`
   (`electron/typebuild/auth.ts:442-447`). If either is unset it returns `null`
   and the daemon **runs without the TypeBuild loop** — the HTTP server still
   serves run-history/overlay so a laptop can attach (`daemon/breezed.ts:515-521`).
3. `signInHeadless()` installs the **memory-only** credential store and calls the
   ordinary `signIn()` (`electron/typebuild/auth.ts:426-432`).
4. `signIn()` POSTs to the Firebase **Identity Toolkit**
   `accounts:signInWithPassword` REST endpoint with the hardcoded public web API
   key — no Firebase SDK, no Electron (`electron/typebuild/auth.ts:224-254`,
   `:49-51`, `:41`).
5. Every later REST call to `https://general.typebuild.com`
   (`electron/typebuild/task-data.ts:68`) attaches `Authorization: Bearer
   <idToken>` from `getIdToken()`, which auto-refreshes against
   `securetoken.googleapis.com` (`electron/typebuild/auth.ts:305-347`, `:354-367`).

The key design fact: **`auth.ts`'s token lifecycle is Electron-free.** The only
Electron dependency is refresh-token *persistence*, hidden behind an injectable
`CredentialStore` (`electron/typebuild/auth.ts:84-172`). The headless daemon
swaps in `memoryOnlyStore` (`:157-163`), so the refresh token lives in module
memory only and **never touches the server's disk**. A daemon restart re-signs-in
from the env creds — there is nothing to persist and nothing to load.

### Copy-pasteable setup

Provision (or reuse) a Firebase email/password identity for the machine — an
account in project `vivekpersonal-1607716465302` **that has a password**
(see the caveat below). Then, on the headless server, make the creds available to
the `breezed` systemd `--user` service and restart it:

```sh
# On the server, as the user that owns the breezed service.
mkdir -p ~/.config/systemd/user/breezed.service.d
cat > ~/.config/systemd/user/breezed.service.d/typebuild-creds.conf <<'EOF'
[Service]
Environment=TYPEBUILD_EMAIL=breezed-svc@example.com
Environment=TYPEBUILD_PASSWORD=REDACTED
EOF
chmod 600 ~/.config/systemd/user/breezed.service.d/typebuild-creds.conf

systemctl --user daemon-reload
systemctl --user restart breezed
journalctl --user -u breezed -n 20 --no-pager   # expect: "[breezed] signed in to TypeBuild as ..."
```

The base unit is written by the installer in `electron/remoteDaemon.ts:103-113`
(`ExecStart=$NODE $D/breezed.mjs`); a drop-in `.conf` is the least-invasive way to
add the environment without editing the generated unit. Any mechanism that puts
`TYPEBUILD_EMAIL` / `TYPEBUILD_PASSWORD` in the daemon's process environment works
(a shell profile, an `EnvironmentFile=`, etc.).

> **Log line to confirm success:** `[breezed] signed in to TypeBuild as <email>`
> (`daemon/breezed.ts:522`). A missing-creds run logs
> `TYPEBUILD_EMAIL / TYPEBUILD_PASSWORD not set` (`:517`); a bad password
> re-throws loudly rather than silently disabling the loop
> (`electron/typebuild/auth.ts:442-447`, `daemon/breezed.ts:507-514`).

### Caveat — the account must have a password

`signIn()` uses `accounts:signInWithPassword` (`auth.ts:50`). An account that
only ever signed in **with Google** has no Firebase password, so the env-cred
path cannot sign it in. The daemon needs a dedicated **email/password service
account** in the same Firebase project. Whether the TypeBuild server authorizes
such an account to see and claim tasks is a **server-side** concern (task
visibility / group membership), out of scope for this client repo.

---

## 1. Path A — transplant the persisted refresh token

**Does not work today.** Two independent blockers.

**A.1 — the persisted blob is not portable.** The GUI stores the refresh token
**encrypted via Electron `safeStorage`** to `userData/typebuild-auth.bin`
(`electron/typebuild/auth.ts:113-115`). `safeStorage` keys are derived per
OS-user / OS-keyring (macOS Keychain, GNOME/KWallet Secret Service, etc.), so a
blob written on the laptop **cannot be decrypted on the server** — the keys are
not shared across machines. `load()` on the server would simply fail the
`decryptString` and return `null` (`auth.ts:123-135`).

**A.2 — on this project's Linux boxes there is often no blob at all.** When no OS
keyring backs `safeStorage`, `isEncryptionAvailable()` is `false` and `save()`
**refuses to write plaintext** — it logs `safeStorage unavailable; refresh token
not persisted` and returns, leaving the session in-memory only for that run
(`auth.ts:105-111`). There is deliberately **no plaintext or derivable on-disk
store** — the only persistence is the `safeStorage` path (GUI) and the
`memoryOnlyStore` no-op (headless) (`auth.ts:99-163`). So on an LXQt / no-keyring
box (this repo's dev boxes — see MEMORY) there is frequently nothing to copy.

**A.3 — even with the raw token in hand, there is no entry point for it.** The
only headless sign-in entry points are `signInHeadless(email, password)` and
`initHeadlessAuth()` (`auth.ts:426`, `:442`). Neither accepts a raw refresh
token. `adoptSession()` (`auth.ts:267`) *would* take a session, but it is only
reachable from the GUI browser-signin flow and still expects an `idToken` +
`refreshToken` pair minted seconds earlier, then hands the refresh token to the
active `CredentialStore` — which, headless, is the memory-only no-op.

**Footguns if you tried anyway:** copying `typebuild-auth.bin` to the server is a
no-op at best (undecryptable) and a **long-lived secret leak** at worst if the
account's `safeStorage` were ever available in plaintext. Do not.

**What would make A work** (design note, not steps): a headless entry point that
accepts a raw Firebase refresh token from the environment (e.g.
`TYPEBUILD_REFRESH_TOKEN`) and calls `doRefresh()` to bootstrap the session. That
is a small, self-contained client change — see §4.

---

## 2. Path B — ssh-forward the loopback OAuth callback

**Does not work today, and cannot be made to with a port-forward alone.**

The browser sign-in flow (`electron/typebuild/browser-signin.ts`) is an OAuth
2.1 + PKCE flow against `general.typebuild.com` (`:55-58`). It has **two** hard
GUI dependencies that a forward tunnel does not satisfy:

1. **A rendered hosted login page in an Electron `BrowserWindow`.**
   `openLoginWindow()` constructs `new BrowserWindow(...)` and `loadURL(authUrl)`
   to show the TypeBuild `/mcp-login` page (`browser-signin.ts:196-217`,
   `:391-433`). Headless breezed has no Electron main process and no
   `BrowserWindow` at all — it is a plain Node bundle
   (`daemon/dist/breezed.mjs`, `electron/remoteDaemon.ts:42-47`). There is
   nothing to render the login page into.

2. **The loopback listener and the token exchange run in the same process.**
   The flow binds `127.0.0.1:<ephemeral>/callback` (`browser-signin.ts:379`,
   `:19-27`), catches the `?code=...` redirect, then does the `/token` exchange
   and `adoptSession()` **in that same process** (`browser-signin.ts:316-374`,
   `completeExchange()` `:454-526`). Forwarding just the loopback port to a
   laptop would land the *session on the laptop* (that's where the exchange and
   `adoptSession` run), not on the server. The listener binds `127.0.0.1` **only,
   never `0.0.0.0`** (`browser-signin.ts:42`, `:379`), which is correct security
   but also means it is not something you point a remote browser at.

So "log in on the laptop, land the session on the server" is not expressible with
this code: the `BrowserWindow` requirement kills it, and even conceptually the
exchange executes wherever the listener is bound. B is dead without new code.

---

## 3. Path C — a provisioned daemon service credential (design proposal)

**Does not exist today.** There is no client_credentials grant, no daemon client
secret, and no non-interactive machine identity anywhere in the repo. This
section is a **proposal**, not steps.

What the platform *does* have, and which points the direction:

- **Open Dynamic Client Registration + PKCE public clients.** browser-signin
  registers a public client via DCR with `token_endpoint_auth_method: 'none'`
  and no client secret (`browser-signin.ts:124-164`). This is a *user*-interactive
  authorization-code flow, not a machine grant — a fresh client_id grants nothing
  until a human signs in (`:84-90`).
- **Firebase-ID-token → scoped access-token exchange.** The just-added
  `electron/typebuild/scheduling-token.ts` exchanges a Firebase ID token at the
  **central AS** `auth.typebuild.com/mcp-token` for an audience-scoped access
  token using an RFC 8707 `resource` indicator
  (`scheduling-token.ts:45-51`, `:123-221`). This shows the platform mints scoped
  tokens — **but still bootstraps from a Firebase identity**, so it does not by
  itself give a daemon a standalone credential.
- **authkit `/connectors`** and the `AUTHKIT_OAUTH_CLIENT_ALLOWLIST` the server
  gates the desktop handoff on (`browser-signin.ts:131-141`) indicate an authkit
  layer that could, in principle, issue a confidential-client credential.

**Proposed shape** (server work — file against the server project, see §4): the
AS issues a **confidential OAuth client** (client_id + client_secret) bound to a
machine/service principal, supporting the `client_credentials` grant (or a signed
JWT assertion) that returns a Firebase-equivalent or AS-audienced token the REST
`TaskSource` can present. The daemon reads the secret from its environment
(`~/.breezefile`-scoped, `0600`) exactly as it reads `TYPEBUILD_*` today, and a
new `auth.ts` headless entry point performs the grant instead of
`signInWithPassword`. This removes the "service account needs a human-style
email/password" awkwardness of the working path in §0.

---

## 4. Security notes and naming

- **The Firebase refresh token is the only persisted secret**, and headless it is
  **not persisted at all** — the daemon uses the memory-only store
  (`electron/typebuild/auth.ts:157-163`); a restart re-signs-in from env creds.
  On the GUI it is persisted **only** encrypted via `safeStorage`
  (`auth.ts:113-115`).
- **Never write ID tokens or PKCE material to disk or logs.** ID tokens live in
  main-process / module memory only (`auth.ts:10-22`); the authorization code and
  PKCE verifier are single-use and never logged (`browser-signin.ts:37-42`,
  `:257-261`). The sign-in debug line logs key **presence only, never token
  values** (`browser-signin.ts:500-513`).
- **`~/.breezefile/api.json` is a LOCAL-daemon bearer, not a TypeBuild
  credential.** It is written `0600` with a random per-process token
  (`electron/api-server.ts:49-61`, `:45-47`) and only authorizes the localhost /
  ssh-tunnelled control API (`electron/remoteDaemon.ts:267-323`). It gates
  nothing on `general.typebuild.com`.
- **`BREEZE_API_TOKEN`** likewise is the *local* api-server bearer, injected into
  the Claude-Code hook environment so the hook can POST tab-state back over the
  tunnel (`electron/hooks-register.ts:100`, `:120-124`) — again, not a TypeBuild
  credential.

**Naming.** This repo is mid-rename from **Breeze File** to the **TypeBuild
client**; internal `breeze*` identifiers are kept for now. In this doc: the
daemon is **`breezed`** (`daemon/breezed.ts`), its state dir is
**`~/.breezefile`**, the local api-server bearer env var is **`BREEZE_API_TOKEN`**.
The DCR client is registered as `client_name: 'Breezefile'` — a **load-bearing**
value the server's allowlist matches against, not display copy
(`browser-signin.ts:131-141`).

---

## Related

- [`breezed-typebuild-repoint.md`](breezed-typebuild-repoint.md) — the daemon's
  repoint onto the online TypeBuild source; §1 "Auth — headless sign-in" is the
  design this doc operationalizes.
- [`scheduling-auth.md`](scheduling-auth.md) — the Firebase-ID-token → central-AS
  scoped-token exchange (`auth.typebuild.com`), the pattern Path C would build on.
</content>
</invoke>
