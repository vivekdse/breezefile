# Cross-Platform Strategy (Mac + Linux)

Breezefile started Mac-first. Linux is a first-class target going forward. This doc is the rule of the road for keeping both platforms healthy without scattering `process.platform` checks across the codebase.

## Principle

**Platform is a property of capabilities, not code paths.** OS-coupled work lives behind a single adapter; UI gates off declared capabilities; new features pick a parity tier deliberately.

## Architecture

### 1. Platform adapter (`electron/platform/`)
One interface — `PlatformAdapter` — captures every OS-coupled operation as a method (search, app launching, external volumes, sound, share, color tags, window chrome, excluded paths, etc.). Two implementations: `MacAdapter`, `LinuxAdapter`. Selected once at startup from `process.platform`. All IPC handlers call `platform.foo(...)` — they never branch on OS.

Unsupported operations return `null` (not throw). The handler reports the gap to the renderer; the UI hides the verb.

### 2. Capability manifest
A single boot-time IPC (`platform:capabilities`) returns a flat boolean map:

```
{ share, colorTags, quickLook, dockBadge, spotlightSearch,
  vibrancy, nativeShareSheet, externalVolumes, ... }
```

The renderer stashes this in `PlatformContext`. Components gate UI on `caps.x`, never on `process.platform`.

### 3. Verb registry knows capabilities
Verbs declare `requires: '<capability>'`. The registry filters unsupported verbs out of the command palette, right-click menu, and help catalog automatically. This is the parity guardrail: a Mac-only verb cannot accidentally surface on Linux.

### 3.5 Per-platform data lives in `~/.breezefile/`
App data that we own (not Electron's `userData`) lives under `~/.breezefile/`:
- `tasks.db` — task store
- `index.db` — Linux file/folder name index (FTS5)

Capability-coupled data files belong to the adapter that owns them. The Linux name index, for example, is created by `LinuxAdapter` on first search and is invisible to `MacAdapter` (which uses Spotlight). New adapters add new files under the same root.

### 4. Per-platform resources
Bundled assets (sounds, default app lists, icons) live under `resources/mac/` and `resources/linux/`, resolved through the adapter. Native binaries (e.g. the Swift sharer) stay conditionally built in `package.json`.

## Parity tiers

Every capability picks one — consciously:

- **Full parity** — both adapters implement it (Open With, trash, sound, external volumes).
- **Degraded parity** — same verb and UI on both; one platform has a worse-but-real implementation (search: Spotlight on Mac, BFS + plocate on Linux). Capability is `true` on both.
- **Single-platform** — capability is `false` on the other side; UI hides the verb. (Share sheet today.)

Default to full or degraded parity. Single-platform requires an explicit reason.

## Rules for new features

1. **No `process.platform` outside `electron/platform/`.** PRs that branch on OS inline are rejected — push the branch into the adapter.
2. **Every OS-coupled feature declares a capability flag** in the manifest and a method on `PlatformAdapter`.
3. **Implement on both platforms by default.** If you're shipping single-platform, justify it in the PR description and set the capability to `false` on the other side.
4. **Verbs declare `requires`.** Don't reach for `caps.x` in component code if a verb gate would do it.
5. **Renderer reads `PlatformContext`, never `navigator.platform` or `process.platform`.**

## How "Share" works under this model

- `MacAdapter.shareFile()` → Swift binary.
- `LinuxAdapter.shareFile()` → returns `null` (or a degraded `xdg-email` fallback if we choose).
- `capabilities.share` is `true` on Mac, `false` on Linux.
- `:share` verb declares `requires: 'share'`; invisible on Linux.
- If we later add KDE Purpose support, the Linux adapter implements it and the capability flips — **no other code changes.**

## Migration order (one-time, when adopting this)

1. Create `electron/platform/index.ts` + `MacAdapter` wrapping current behavior verbatim. Pure refactor, no behavior change.
2. Add capability manifest IPC + `PlatformContext`. Convert existing renderer `process.platform` checks.
3. Add `LinuxAdapter` with stubs returning `null`. App boots on Linux with most features off.
4. Fill in `LinuxAdapter` methods one capability per PR — each flips a flag `false → true`.
5. Add `requires` to verb registry; remove residual inline branches.
6. CI matrix: macos-latest + ubuntu-latest.

## Remote machines & task scheduling

- The task scheduler (`electron/scheduler.ts`) is **in-process** — a single
  timer keyed off `MIN(next_run_at)`, with a hand-rolled 5-field cron parser
  (`electron/cron.ts`, no native deps). There is **no launchd/systemd
  coupling**, so recurring/auto tasks work identically on Linux and macOS as
  long as the app is running. Missed fires while the app was closed are
  skipped (the scheduler rolls `next_run_at` forward on startup).
- **Per-machine task ownership (breezed).** The `:remote-attach` verb
  (alias `connect`) picks a host from the active sshfs mounts and
  connects it as a task *source*. `electron/remoteDaemon.ts` ssh-installs
  a headless `breezed` daemon there (`daemon/breezed.ts` — the same
  store + scheduler + agent executor, no Electron, sharing
  `electron/core/task-http.ts`), runs it under a lingering
  `systemd --user` unit (survives disconnect **and** reboot;
  self-linger needs no sudo), and opens a forward `ssh -L` tunnel.
  `electron/sources.ts` is the laptop-side registry; the task IPC
  aggregates `local` + every connected host, tagging each task with
  `source`, and routes mutations to the owning machine. `tasks:create`
  with no pinned source resolves the folder against connected hosts'
  sshfs mounts — a folder under a connected mount is created on that
  host's daemon with the path rewritten to the real remote path. No
  sync, no merge: a task lives on exactly one machine and that machine
  fires its own scheduled/auto runs 24/7. Connected hosts persist and
  reconnect best-effort on launch (`restoreSources`).
  better-sqlite3 on the server uses the official prebuilt for its Node
  ABI (npm's prebuild-install is unreliable on some hosts), fetched by
  the installer; `npm install --ignore-scripts` lays down JS only.
- The reverse-ssh `:remote-attach` (single laptop store + session
  tokens) and its hidden-pty v2 were **superseded** by the above. The
  now-unused reverse-tunnel path in `electron/ipc.ts` +
  `electron/session-tokens.ts` are kept inert pending a cleanup pass.
  `GET /remote/resolve` is still used — by the auto-route logic and the
  SessionStart hook (`bin/breeze.mjs`) — to map a local sshfs cwd to its
  `ssh://<host><remote-path>` identity.

## Canonical capability list

Maintained in `electron/platform/CAPABILITIES.md` — one row per flag with a one-line meaning. New capability = new row + new adapter method + (optionally) new verb `requires`. Keep it the source of truth.
