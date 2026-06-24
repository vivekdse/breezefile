# TypeBuild

The desktop client for **getting work done with AI agents.** Tasks are the
primitive: you see the tasks you (and your team) have, run them yourself or hand
them to an agent, and watch the automated work happen — across your machines and
across your team. The keyboard-first file manager this project started as lives
on as one of the abilities the client and its agents use.

> Status: early personal build, mid-rename. Started as **Breeze File**, a
> ranger-inspired file manager; pivoting to the **TypeBuild client**. Unsigned,
> distributed via my own Homebrew tap. Internal identifiers (the `breezefile`
> package/cask/bundle id) still say "breeze" while the rename is in progress.

## What it does

- **Tasks, online and shared** — one task system (TypeBuild). Tasks live online,
  so they're shared across a team and across one person's multiple machines.
  No separate local task list to keep in sync.
- **Run tasks, or hand them to an agent** — execute a task yourself, or let an
  AI agent do it. Agents operate your browser (Playwright-driven), touch files,
  and open apps to complete the work, with sensitive submissions gated on
  explicit human confirmation.
- **Watch automation happen** — see what's ready, what's running, what an agent
  is doing right now, and what's blocked. Automated work is resumable and
  auditable: every step records state and a one-line "why".
- **PII stays out of the agent's context** — sensitive values ride a task `data`
  field as placeholder keys; real values are decrypted server-side at fill time
  (see [`docs/typebuild-data-field-contract.md`](docs/typebuild-data-field-contract.md)).

### The file-manager abilities (still here)

- **Verb-first command prompt** — start typing anywhere (`copy`, `move`,
  `sort`, `theme`, `goto`/`find`, `delete`, …). No memorized chords needed.
- **Vim-style navigation** alongside the prompt: `h j k l`, arrows,
  `gg`/`G`, `H`/`L` for back/forward, bookmarks (`m<key>` / `'<key>`),
  tabs, sort/view shortcuts.
- **Native drag-out to other apps** — drag a row to Slack, Gmail, Finder,
  whatever. Multi-file drag carries the whole marked set with a `+N` chip.
- **Spotlight + local subfolder search**, editorial themes, stage-then-explore
  copy/move, confirm dialogs, bulk rename, "Open With…", miller-style preview,
  file thumbnails.

Deferred for now: file-content preview pane (text peek exists), Linux
packaging (Linux runs via `npm run dev` for now).

## Install

### Homebrew (recommended)

```sh
brew tap vivekdse/tap
brew install --cask breezefile
```

The cask strips the macOS quarantine bit, so Gatekeeper won't block the
unsigned app on first launch.

### Updating

```sh
brew upgrade --cask breezefile     # upgrade Breeze File only
brew upgrade                        # upgrade everything brew manages
```

Breeze File also surfaces a quiet "update available" pill in the
bottom-left when a new release lands (checked once a day against the
GitHub Releases API), with the upgrade command one click away.

### Direct DMG

Grab `Breezefile-<version>-arm64.dmg` (Apple Silicon) or
`Breezefile-<version>.dmg` (Intel) from the
[Releases page](https://github.com/vivekdse/breezefile/releases) and drag
into `/Applications`. Because the app is unsigned, macOS will quarantine
it on first launch — strip the bit once:

```sh
xattr -cr "/Applications/Breeze File.app"
```

If folder-permission prompts loop on first launches, also run:

```sh
sudo tccutil reset All com.vivek.breezefile
```

(then grant each folder once and the grants will stick).

## Build from source

```sh
git clone https://github.com/vivekdse/breezefile.git
cd breezefile
npm install
npm run dev          # Vite + Electron with HMR
```

Or build the macOS bundle:

```sh
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac
# → release/Breezefile-<version>-arm64.dmg + .zip + Intel variants
```

## Linux

Linux is supported via `npm run dev`. A packaged Linux binary (AppImage)
is on the roadmap; the dev workflow already gives you a working app.

### Prerequisites

- **Node.js 20+** and **npm** (use `nvm` or your distro's package manager).
- **Python 3** and a **C/C++ toolchain** — `better-sqlite3` builds a native
  module on install. Ubuntu/Debian: `sudo apt install build-essential python3`.
  Fedora: `sudo dnf install @development-tools python3`. Arch: `base-devel`.
- **Electron's runtime libraries.** Most desktops already have these; if
  Electron complains, install the deps it names. On Ubuntu/Debian a typical
  install includes: `libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2`.

### Run

```sh
git clone https://github.com/vivekdse/breezefile.git
cd breezefile
npm install
npm run dev
```

### What works on Linux today

- Native, keyboard-first navigation; tabs, bookmarks, marks, sort.
- **Native file/folder search** — backed by a local SQLite name index at
  `~/.breezefile/index.db`. First launch kicks off a background walk of
  `$HOME` (heavy dirs like `node_modules`, `.cache`, `.venv` are skipped);
  while it builds, queries fall back to a live bounded walk so you get
  results immediately. Subsequent queries are millisecond reads against
  the FTS5 index. The index refreshes in the background after 6 hours.
- Drag-out to other apps (Chromium's native HTML5 drag works under both
  X11 and Wayland).
- Editor themes, command prompt, bulk rename, "Open With…" via `xdg-open`.

### What's macOS-only today

The macOS share sheet, Finder color tags, Quick Look (`qlmanage`), iCloud
Drive sidebar entry, and the dock-badge attention chime. The UI hides
these verbs on Linux via the capability manifest — see
[`docs/cross-platform-strategy.md`](docs/cross-platform-strategy.md) for
how features are gated and how to add Linux parity for a given verb.

### Data locations

- Tasks live **online** in the TypeBuild service — there is no local task DB.
  (The legacy `~/.breezefile/tasks.db` is being removed with the local task
  source.)
- `~/.breezefile/index.db` — the file/folder name index (Linux).
- `~/.config/breezefile/` (or the platform's Electron `userData`) —
  per-extension Open With bindings, terminal preferences, thumbnail cache.

## Stack

- Electron 33 + React 19 + Vite 6 + TypeScript
- electron-builder for `.dmg` / `.zip`
- Editorial palette built on Fraunces (display), Inter Tight (UI), and
  JetBrains Mono (kbd).

## Why "TypeBuild"?

The product is the place you **build** things by expressing work as tasks an
agent (or you) carries out — much of it by **typing** the action you want rather
than memorizing a UI. It grew out of *Breeze File*, a keyboard-first file
manager (ranger's speed without ranger's chord-memorization wall), and that
file surface survives as an ability the client uses. The pivot: the point is no
longer managing files — it's getting work done with agents, with files as one of
the tools.

## License

MIT — do whatever, but the unsigned build is provided as-is.
