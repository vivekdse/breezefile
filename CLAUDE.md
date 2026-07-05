# TypeBuild (client)

The desktop **client for getting work done with AI agents.** A person (and their
team, across machines) sees the tasks they have, executes them, and watches
automated tasks run — with the file-manager surface as one of the abilities the
agent uses, not the point of the product.

> **Renaming in progress.** This repo started as **Breeze File** (a ranger-inspired
> file manager) and is being reframed as the **TypeBuild client**. User-facing
> names move to "TypeBuild"; internal identifiers (package name, bundle id
> `com.vivek.breezefile`, the Homebrew cask, `breeze*` code symbols) are kept
> for now and renamed in a later mechanical pass. Expect both names in the code.

## What this is now
- **Tasks are the fundamental primitive.** A task is a unit of work — for the
  human or for an agent — and the client is the place you see, execute, and
  monitor them. Tasks are **online and shared**: distributed across a team and
  across a single person's multiple machines.
- **TypeBuild is the one task system.** There is no longer a separate local task
  store. All tasks live in the online TypeBuild service (encrypted, PHI-aware)
  and the client reaches them through the **TypeBuild MCP** + REST. The old local
  `breeze` task DB, `breeze` CLI, and `breeze-mcp` are being removed.
- **Agents get things done.** The Playwright/browser-automation layer
  (`electron/browser/`) lets agents operate the user's browser to complete tasks;
  the file surface, "Open With", drag-out, etc. are abilities an agent (or the
  human) uses along the way.

## Stack
- Electron + React + Vite + TypeScript
- Packaging: electron-builder (.dmg + .zip)
- Distribution: unsigned, via personal Homebrew cask tap (no Apple Developer fee; cask strips quarantine so no Gatekeeper warning)

## The file-manager surface (still here)
Ranger-like affordances remain as an ability set: vim navigation, selection/yank/paste, sorting, tabs, command mode, bookmarks, bulk rename, tagging, miller columns, list + thumbnail views, "Open With", native drag-out to web apps. These are no longer the product's reason for being — they are tools the client and its agents use to do work.

**Deferred:** file-content preview pane, Linux packaging.

## Tasks: one online system (TypeBuild)
There is a single task system: **TypeBuild, online.** The seam lives in
`electron/core/task-source.ts` (the `TaskSource` interface) and
`electron/sources/`. TypeBuild (`electron/sources/typebuild.ts`) is the source;
the local sqlite source (`electron/sources/local.ts`) and the `breeze` CLI /
`breeze-mcp` are being **removed** — see the CLI-unification task in TypeBuild.
Agents reach tasks through the **TypeBuild MCP** (`mcp__typebuild__*`), not a
local CLI.

Task bodies are **PHI-sensitive**: never persist decrypted task text to disk,
logs, or notifications (`TaskSourceCapabilities.phiSensitive`). PII rides the
task `data` field as placeholder keys only — see
[`docs/typebuild-data-field-contract.md`](docs/typebuild-data-field-contract.md)
and [`docs/pii-data-injection-design.md`](docs/pii-data-injection-design.md).

## Cross-platform (Mac + Linux)
The client targets both macOS and Linux. **Before adding any OS-coupled feature** (search, app launching, volumes, sound, share, window chrome, etc.), read [`docs/cross-platform-strategy.md`](docs/cross-platform-strategy.md). Rules in brief: no `process.platform` outside `electron/platform/`; OS-coupled work goes through the `PlatformAdapter`; UI gates on the capability manifest via `PlatformContext`; verbs declare `requires: '<capability>'`. Default to full or degraded parity — single-platform features require justification.

## Tracking
**Development work is tracked in TypeBuild** (the same online task system the product targets) via the **TypeBuild MCP** (`mcp__typebuild__*`): `list_tasks` to see work, `create_task` to file it, `parent_task_id` for containment and `depends_on` for ordering. **beads has been removed** — do not use `bd`, TodoWrite, or markdown TODO lists for tracking. Active thread: the CLI-unification / local-task-removal epic (`task-4449675c1226` and its children).

## Origin
Started 2026-04-21 as **Breeze File**, a ranger-inspired file manager, after discovering that `ripdrag`/`dragon` don't work on macOS and ranger has no drag-out mechanism. It has since pivoted to the **TypeBuild client** — an agentic work client where tasks are the primitive and the file manager is one ability. A `clipfile` helper (`~/.local/bin/clipfile`) exists as a stopgap that copies files to the clipboard for ⌘V paste into web apps.

## Help system maintenance
The slide-based help lives in `src/components/HelpTour.tsx`, opened via the `:help` verb or the **Help** button in the Statusbar. **Whenever you ship a new feature or verb, update HelpTour to reflect it** — add a row to the relevant catalog slide (or a new slide if it's a new category). The catalog is the user's reference; a stale catalog erodes trust quickly. Tutorial (`src/components/Tutorial.tsx`) is the interactive walkthrough and is separate; it doesn't need a per-feature update unless the basics change.


## Issue Tracking (TypeBuild)

Development work for this repo is tracked in **TypeBuild**, via the TypeBuild MCP
(`mcp__typebuild__*`). beads has been removed.

- **Find work:** `list_tasks` (filter by `parent`, `status`, etc.).
- **File work:** `create_task` — use `parent_task_id` for containment (epics →
  children) and `depends_on` for ordering.
- **Server-side follow-ups go on `task_manager_api`, not here.** This repo is the
  **client**; the server is the FastAPI "brain" `task_manager_api`
  (repo `~/git_repos/small_business_software/software/task_manager_api`, live at
  general.typebuild.com, tmux `taskapi`). Whenever client work surfaces a change
  that must land on the server (a REST/MCP endpoint, the task/PHI schema, a wire
  contract, deploy/smoke), **automatically file it as a `create_task` against the
  server project — `project_id="project-df6cef3fbc84"`** — rather than leaving it
  as a client task or a loose note. Cross-reference the originating client task/PR
  in the body. (General rule: resolve each repo → its TypeBuild project via
  `resolve_project_folder` and anchor the task to that `project_id`.)
- Do **not** use `bd`, TodoWrite, or markdown TODO lists for tracking.
- Task titles/bodies may be **PHI** — keep them in the conversation; never write
  them to files, notes, or logs.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File follow-up tasks in TypeBuild** - Create tasks for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update task status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
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
