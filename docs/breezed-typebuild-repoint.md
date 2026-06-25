# breezed → TypeBuild repoint (design)

**Status:** in progress · 2026-06-25 · TypeBuild task `task-6045df9dcf9b`

## Goal

The `breezed` per-machine daemon (`daemon/breezed.ts`) used to own a local sqlite
task store and run its own auto/cron tasks against it. The local task source is
gone (TypeBuild is the only task system). The daemon's **purpose is unchanged** —
per-machine, headless execution of automated tasks — but the **source is now
online: TypeBuild**. This doc captures how the repoint works.

## The three gaps (and how we close them)

### 1. Auth — headless sign-in

The TypeBuild source authenticates every REST call with a **Firebase ID token**
(`electron/typebuild/auth.ts`). That module signs in via the Firebase Identity
Toolkit **email/password REST** endpoint — **no browser required** — and persists
the refresh token via Electron `safeStorage`.

Under headless breezed there is **no Electron `safeStorage`**. So the daemon needs
its credentials from the environment:

- `TYPEBUILD_EMAIL` + `TYPEBUILD_PASSWORD` — service credentials for the machine.
  The daemon signs in once at startup via the same Identity Toolkit REST call and
  then relies on `getIdToken()`'s in-memory refresh.
- The refresh token stays **in memory only** on the daemon (no `safeStorage` to
  persist to, and a server box shouldn't write long-lived creds to disk in the
  clear). A daemon restart re-signs-in from the env credentials.

`auth.ts` is refactored so its token lifecycle (refresh, single-flight, skew) is
reusable **without** Electron: the `safeStorage` persistence becomes an injectable
"credential store" with a headless (env-creds, memory-only) implementation.

### 2. Claim-next — pull the next automated task

The REST `TaskSource` only exposes per-id `claim`. The daemon needs "give me the
next claimable automated task for this machine" — the equivalent of the MCP's
`claim_next_task`. We add a source method `claimNext(opts)` that calls the
server's claim-next endpoint (same one the MCP `claim_next_task` verb is built on)
filtered to **`auto`-flagged** tasks the daemon is allowed to run. It returns the
claimed task (decrypted body in memory) or null when the queue is empty.

### 3. Execution — headless, task-dependent browser

`executeTaskRun` (`electron/agents/execute.ts`) is the **headless** runner (spawns
`claude` via `claude.ts`, records a run row) and is already Electron-free. The
daemon runs claimed TypeBuild tasks through it — NOT through the source's
interactive `runNow` (which needs a GUI window + browser tab).

**Task-dependent browser (the autonomy rule, updated 2026-06-25):** the old
blanket rule "final form submissions always need explicit human confirmation" is
**removed**. Whether a task needs a browser / a human gate is **a property of the
task**, expressed in its flags:

- A task flagged `playwright` / `chrome` is **browser-based** — it drives a real
  browser and is **not headless**. The daemon does **not** run these
  unattended; they are left for an interactive (GUI) session that can host the
  browser. The daemon skips a claimed browser task back to the queue (releases
  it) rather than failing it.
- A task with no browser flag (e.g. plain `auto`) is **headless-safe** and the
  daemon executes it end to end.

Confirmation/gating is therefore task-dependent: it depends on what the task is
and how it was authored, not a global rule.

## The daemon loop

Replaces the local-store scheduler half. On the server (no window):

1. **Sign in** from `TYPEBUILD_EMAIL` / `TYPEBUILD_PASSWORD` (memory-only creds).
2. **Register** the TypeBuild source (so `getTaskSource('typebuild')` resolves and
   the REST helpers work) — but **without** the GUI-only polling/notification
   surface.
3. **Poll-claim-execute loop:** every N seconds, `claimNext({ headlessOnly: true })`.
   - null → nothing to do; wait and retry.
   - a browser-flagged task slips through → release it (leave for a GUI session).
   - else → `executeTaskRun(task)` headlessly; on finish, report the outcome to
     TypeBuild (submit/complete) and loop.
4. Honor `MAX_CONCURRENT`; reap nothing local (no local rows anymore).

The schedule-overlay path (GUI scheduling of interactive TypeBuild tasks) is
unchanged and stays out of the daemon. `electron/tasks.ts` / `tasks.db` remain as
the run-history + overlay backing store only.

## PHI

The daemon already runs with the `HeadlessBreezeHost`, which **logs only opaque
ids** (PHI-free). Decrypted task bodies live in daemon memory only — never the
run-history rows, never logs. The `executeTaskRun` PHI guard
(`PHI_SENSITIVE_SOURCES`) already forces content-free notifications for the
`typebuild` source; we keep that.

## Open / follow-up

- Per-task data (`data` placeholder fill) is browser-helper territory; headless
  tasks that need `data` are effectively browser tasks and are skipped by the
  daemon under the rule above.
- A richer "which machines may run which tasks" routing (assignment/group) can
  ride on `claimNext` filters later.
