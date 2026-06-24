# Agent Instructions

This is the **TypeBuild client** — a desktop client for getting work done with
AI agents, where tasks are the primitive. (It began as *Breeze File*, a
file manager; that surface is now one of the client's abilities. See
[`CLAUDE.md`](CLAUDE.md) and [`docs/value-proposition.md`](docs/value-proposition.md).)

## Task system: TypeBuild only (online)

There is **one task system: TypeBuild, online.** Operate user tasks through the
**TypeBuild MCP** (`mcp__typebuild__*`) — `list_tasks`, `claim_next_task`,
`submit_task`, etc. The old local `breeze` CLI and `breeze-mcp` are being
removed; do **not** reach for a local task store or a `breeze task …` command.

Task bodies are **PHI**: keep them in the conversation only — never write them to
files, notes, or logs. Skills/notes/notifications are shared and must stay
PHI-free. Final form submissions always need explicit human confirmation.

> Note: **the user's TypeBuild tasks and this repo's development tracking are
> both in TypeBuild but are different things** — don't conflate user work with
> dev tasks. Development tasks are filed via `create_task` with a `parent_task_id`
> grouping them under a dev epic.

---

## Issue tracking (TypeBuild)

Development work for this repo is tracked in **TypeBuild** via the TypeBuild MCP
(`mcp__typebuild__*`). **beads has been removed** — do not use `bd`, TodoWrite,
or markdown TODO lists.

- `list_tasks` — find available work (filter by `parent`, `status`).
- `create_task` — file work; `parent_task_id` for containment, `depends_on` for
  ordering.
- `update_task` — human-directed status/routing changes only.
- Task titles/bodies may be **PHI**: keep them in the conversation; never write
  them to files, notes, or logs.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
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
