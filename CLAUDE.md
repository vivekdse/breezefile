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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
