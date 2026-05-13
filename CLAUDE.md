# file_manager

Cross-platform (Mac-first) GUI file manager inspired by ranger, with the key feature ranger lacks on macOS: **native drag-out of files to web apps like Slack and Gmail**.

## Stack
- Electron + React + Vite + TypeScript
- Packaging: electron-builder (.dmg + .zip)
- Distribution: unsigned, via personal Homebrew cask tap (no Apple Developer fee; cask strips quarantine so no Gatekeeper warning)

## Scope (v1)
Ranger-like affordances: vim navigation, selection/yank/paste, sorting, tabs, command mode, bookmarks, bulk rename, tagging, miller columns, list + thumbnail views. Plus: settings UI for keybindings, right-click "bind folder to key", right-click "Open With" with sensible defaults falling back to macOS `open`.

**Deferred:** file-content preview pane, Linux packaging.

## Cross-platform (Mac + Linux)
Breezefile targets both macOS and Linux. **Before adding any OS-coupled feature** (search, app launching, volumes, sound, share, window chrome, etc.), read [`docs/cross-platform-strategy.md`](docs/cross-platform-strategy.md). Rules in brief: no `process.platform` outside `electron/platform/`; OS-coupled work goes through the `PlatformAdapter`; UI gates on the capability manifest via `PlatformContext`; verbs declare `requires: '<capability>'`. Default to full or degraded parity — single-platform features require justification.

## Tracking
Work is tracked in beads (`bd list`). Epic: `fm-ubk`. Run `bd ready` to see unblocked tasks.

## Origin
Started 2026-04-21 after discovering that `ripdrag`/`dragon` don't work on macOS and ranger has no drag-out mechanism. A `clipfile` helper (`~/.local/bin/clipfile`) exists as a stopgap that copies files to the clipboard for ⌘V paste into web apps.

## Help system maintenance
The slide-based help lives in `src/components/HelpTour.tsx`, opened via the `:help` verb or the **Help** button in the Statusbar. **Whenever you ship a new feature or verb, update HelpTour to reflect it** — add a row to the relevant catalog slide (or a new slide if it's a new category). The catalog is the user's reference; a stale catalog erodes trust quickly. Tutorial (`src/components/Tutorial.tsx`) is the interactive walkthrough and is separate; it doesn't need a per-feature update unless the basics change.
