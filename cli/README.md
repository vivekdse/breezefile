# breeze — CLI for Breeze File

A thin HTTP client for the running [Breeze File](../README.md) app. The CLI never touches the SQLite store directly; it speaks to the local API server the app exposes on `127.0.0.1:<random-port>` (token in `~/.breezefile/api.json`). If the app isn't running, `breeze` exits with code 2 and a clear message.

This means every verb you can invoke from the CLI is a verb the app itself understands — so commands like `breeze open <folder>` and `breeze task open` drive the live UI rather than mutating data behind the app's back.

## Install (dev)

```sh
./install.sh
# → links cli/breeze.mjs into ~/.local/bin/breeze
```

If `~/.local/bin` is not on your `PATH`, add this to your shell rc:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```sh
breeze status
# ok  port=54123  pid=8881  name=breeze
```

## Requirements

- Node 18+ (uses the global `fetch`)
- The Breeze File desktop app, running.

No npm install needed — the CLI has zero runtime dependencies.

## Commands

```text
breeze status

breeze task list   [--status=S] [--folder=PATH] [--pinned]
                   [--search=TEXT] [--active] [--show-completed] [--json]
breeze task show   [<id>] [--json]
breeze task add    "<title>" [--folder PATH] [--ref-folder PATH]
                   [--start YYYY-MM-DD] [--due YYYY-MM-DD]
                   [--notes TEXT] [--pin]
breeze task edit   [<id>] [--title TEXT] [--folder PATH] [--ref-folder PATH]
                   [--start ...] [--due ...] [--notes TEXT]
                   [--status S] [--pin|--unpin]
breeze task done   [<id>]
breeze task pin    [<id>]
breeze task unpin  [<id>]
breeze task delete [<id>] --yes
breeze task open   [<id>]

breeze open        <folder>
breeze tabs        [--json]
breeze help        [<cmd>]
```

### Defaults

- `breeze task add` uses `$PWD` as the task's folder when `--folder` is omitted, matching the in-app quick-add behavior.
- All `<id>` arguments default to `$BREEZE_TASK_ID` when not given. Breeze's task-tab terminals set this for you, so an agent running there can run `breeze task show` without wiring up the id. A positional `<id>` always wins.

### Output

Default output is human-readable with status pills and aligned tables. Read commands accept `--json` for scripting (Claude / Codex / Gemini parse this).

### Exit codes

- `0` — ok
- `1` — error (HTTP 4xx/5xx, bad input, …)
- `2` — Breeze isn't running (no `api.json`, dead pid, or connection refused)
