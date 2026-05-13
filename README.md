# Breeze File

A breezy, ranger-inspired file manager for macOS and Linux. Built because I
missed ranger's keyboard-first workflow but wanted **native drag-out to web
apps like Slack and Gmail** — something ranger and the Linux helpers
(`ripdrag`, `dragon`) can't do on macOS.

> Status: early personal build. Unsigned, distributed via my own Homebrew
> tap. Use at your own pace.

## What's in v1

- **Verb-first command prompt** — start typing anywhere (`copy`, `move`,
  `sort`, `theme`, `goto`/`find`, `delete`, …). No memorized chords needed.
- **Vim-style navigation** alongside the prompt: `h j k l`, arrows,
  `gg`/`G`, `H`/`L` for back/forward, bookmarks (`m<key>` / `'<key>`),
  tabs, sort/view shortcuts.
- **Stage-then-explore copy/move** — pick a destination, the app navigates
  you there, a floating chip lets you `ph` (paste here) once you've found
  the exact subfolder. Move is gated by a confirm dialog.
- **Native drag-out to other apps** — drag a row to Slack, Gmail, Finder,
  whatever. Multi-file drag carries the whole marked set with a `+N` chip.
- **Spotlight + local subfolder search** — typing in the goto/find prompt
  ranks current-folder children, then descendants, then recents and
  bookmarks, with Spotlight hits last.
- **Editorial themes** — Paper / Pastel / Peony / Plum / Clay / Moss /
  Linen / Rose / Dawn / Dusk. Pick via the `theme` verb (live-preview as
  you arrow through).
- **Confirm dialogs** for destructive ops with `Y` / `N` keyboard shortcuts.
- **Single-file create**, bulk rename, "Open With…" with sensible
  defaults, miller-style preview pane, file thumbnails.

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

- `~/.breezefile/tasks.db` — the task store (existing).
- `~/.breezefile/index.db` — the file/folder name index (Linux).
- `~/.config/breezefile/` (or the platform's Electron `userData`) —
  per-extension Open With bindings, terminal preferences, thumbnail cache.

## Stack

- Electron 33 + React 19 + Vite 6 + TypeScript
- electron-builder for `.dmg` / `.zip`
- Editorial palette built on Fraunces (display), Inter Tight (UI), and
  JetBrains Mono (kbd).

## Why "Breeze File"?

Ranger is incredible but keyboard-only and Linux-native. Finder is
discoverable but slow for power users. Breeze File aims for both:
typing-driven verbs for people who lean on the keyboard, plus visible
chips and confirm dialogs so a non-vim user can still drive it on day one.
The "breeze" is the easy-mode promise; the file glyph in the icon is the
literal subject.

## License

MIT — do whatever, but the unsigned build is provided as-is.
