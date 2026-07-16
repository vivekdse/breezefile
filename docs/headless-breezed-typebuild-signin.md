# Headless breezed → TypeBuild sign-in on an external server

**Status:** investigation + how-to — written for TypeBuild task `task-f19c954b5f28`.
Grounded entirely in the client source as of 2026-07-12; every claim cites a
`file:line`.

**Verdict up front.** A **fully-headless** breezed daemon (no GUI, ssh only)
**can** authenticate to TypeBuild today — including transplanting a session, as
of `initHeadlessAuth()`'s `TYPEBUILD_REFRESH_TOKEN` path (task-6e6f4acb5d65;
see §1 below). There is still no ssh-forwarded browser flow. Of the three
candidate paths this task asked about:

| Path | Works today? | Why |
| --- | --- | --- |
| **A. Transplant the persisted refresh token** from a GUI box | **Yes, as of task-6e6f4acb5d65** | `initHeadlessAuth()` reads a raw refresh token from `TYPEBUILD_REFRESH_TOKEN` and bootstraps the session via `doRefresh()` — see §1. |
| **B. ssh-forward the loopback OAuth callback** | **No** | The flow requires an Electron `BrowserWindow` and runs the token exchange in the same GUI process — headless breezed has neither. |
| **C. Provisioned daemon service credential (client_credentials)** | **Not built** | No such grant exists; presented below as a design proposal. |

There are now **two** working headless entry points, tried in this priority
order by `initHeadlessAuth()`:

1. **`TYPEBUILD_REFRESH_TOKEN`** (§1) — a raw Firebase refresh token minted
   interactively (e.g. on a GUI machine) and handed to the daemon via env. This
   is the **only** path that works for a **Google-OAuth-only account** (no
   Firebase password), since it skips `signInWithPassword` entirely.
2. **`TYPEBUILD_EMAIL` + `TYPEBUILD_PASSWORD`** (§0) — the original service
   credential, for an account that has a Firebase password.

Both are memory-only: the refresh token is held in module memory only and
**never written to disk**, per the discipline documented in §4.

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

**Works today** (task-6e6f4acb5d65). `initHeadlessAuth()`
(`electron/typebuild/auth.ts:448-477`) checks `TYPEBUILD_REFRESH_TOKEN` first;
if set, it calls `signInHeadlessWithRefreshToken(refreshToken)`
(`auth.ts:448-455`), which installs the memory-only credential store (same one
`signInHeadless` uses) and exchanges the token via the existing `doRefresh()`
securetoken call (`auth.ts:305-347`) — no `signInWithPassword`, no password
needed. This is the path that makes a **Google-OAuth-only** account usable
headlessly: mint a session interactively (GUI sign-in, any provider), read the
resulting refresh token, and hand it to the daemon's environment.

### Copy-pasteable setup

```sh
# On the server, as the user that owns the breezed service.
mkdir -p ~/.config/systemd/user/breezed.service.d
cat > ~/.config/systemd/user/breezed.service.d/typebuild-creds.conf <<'EOF'
[Service]
Environment=TYPEBUILD_REFRESH_TOKEN=REDACTED
EOF
chmod 600 ~/.config/systemd/user/breezed.service.d/typebuild-creds.conf

systemctl --user daemon-reload
systemctl --user restart breezed
journalctl --user -u breezed -n 20 --no-pager   # expect: "[breezed] signed in to TypeBuild as ..."
```

`TYPEBUILD_REFRESH_TOKEN` takes priority over `TYPEBUILD_EMAIL` /
`TYPEBUILD_PASSWORD` when both are set (`auth.ts:471-478`). If the token is
revoked or expired, `doRefresh()` throws the Firebase error code (e.g.
`TOKEN_EXPIRED`) and `initHeadlessAuth()` re-throws it — loud, not silently
disabling the loop, same as a bad password today.

**Caveat — this is still a bootstrap, not a renewal mechanism.** The
refresh token itself may eventually be revoked (e.g. the source GUI session
signs out, or the token is rotated away). There's no admin flow yet for
minting a long-lived, non-interactive refresh token independent of a human
GUI sign-in — mint a fresh one and update the env var if the daemon's session
stops refreshing.

**What still does NOT work, and never will: copying the raw `safeStorage`
blob file.** The GUI persists the refresh token **encrypted via Electron
`safeStorage`** to `userData/typebuild-auth.bin` (`electron/typebuild/auth.ts:113-115`).
`safeStorage` keys are derived per OS-user / OS-keyring (macOS Keychain,
GNOME/KWallet Secret Service, etc.), so a blob written on the laptop **cannot
be decrypted on the server** — the keys are not shared across machines.
`load()` on the server would simply fail the `decryptString` and return `null`
(`auth.ts:123-135`). On this project's Linux boxes there is often no blob at
all: when no OS keyring backs `safeStorage`, `isEncryptionAvailable()` is
`false` and `save()` **refuses to write plaintext** (`auth.ts:105-111`), so on
an LXQt / no-keyring dev box there is frequently nothing to copy either.
**Footgun:** copying `typebuild-auth.bin` to the server is a no-op at best
(undecryptable) and a **long-lived secret leak** at worst if the account's
`safeStorage` were ever available in plaintext. Do not.

**What DOES work (as of task-6e6f4acb5d65):** don't transplant the encrypted
file — extract the *raw* refresh token from a live GUI session (e.g. log it
once from a debug build, or read it via a one-off `getIdToken`-adjacent debug
hook on the GUI machine) and hand that raw string to the server via
`TYPEBUILD_REFRESH_TOKEN`. `initHeadlessAuth()` now has an entry point for
exactly this (`auth.ts:448-477`) — see the setup steps above.

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
`signInWithPassword`. This would remove the last operational rough edge of
§1's `TYPEBUILD_REFRESH_TOKEN` path — a periodic manual re-mint if the token
is ever revoked — by having the daemon itself hold a durable, revocable
machine credential instead of a borrowed human-session token.

---

## 4. Security notes and naming

- **The Firebase refresh token is the only persisted secret**, and headless it is
  **not persisted at all** — both headless entry points
  (`signInHeadlessWithRefreshToken()`, `signInHeadless()`) install the
  memory-only store (`electron/typebuild/auth.ts:157-163`) before signing in;
  a restart re-bootstraps from env (`TYPEBUILD_REFRESH_TOKEN` or
  `TYPEBUILD_EMAIL`/`TYPEBUILD_PASSWORD`). The `TYPEBUILD_REFRESH_TOKEN` value
  itself is never logged, not even partially (`auth.ts:426-478`) — the only
  thing that flows to logs on failure is the Firebase error code (e.g.
  `TOKEN_EXPIRED`), same as every other failure path in this module. On the
  GUI the refresh token is persisted **only** encrypted via `safeStorage`
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
