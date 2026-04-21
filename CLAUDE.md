# file_manager

Cross-platform (Mac-first) GUI file manager inspired by ranger, with the key feature ranger lacks on macOS: **native drag-out of files to web apps like Slack and Gmail**.

## Stack
- Electron + React + Vite + TypeScript
- Packaging: electron-builder (.dmg + .zip)
- Distribution: unsigned, via personal Homebrew cask tap (no Apple Developer fee; cask strips quarantine so no Gatekeeper warning)

## Scope (v1)
Ranger-like affordances: vim navigation, selection/yank/paste, sorting, tabs, command mode, bookmarks, bulk rename, tagging, miller columns, list + thumbnail views. Plus: settings UI for keybindings, right-click "bind folder to key", right-click "Open With" with sensible defaults falling back to macOS `open`.

**Deferred:** file-content preview pane, Linux packaging.

## Tracking
Work is tracked in beads (`bd list`). Epic: `fm-ubk`. Run `bd ready` to see unblocked tasks.

## Origin
Started 2026-04-21 after discovering that `ripdrag`/`dragon` don't work on macOS and ranger has no drag-out mechanism. A `clipfile` helper (`~/.local/bin/clipfile`) exists as a stopgap that copies files to the clipboard for ⌘V paste into web apps.
