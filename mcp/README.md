# breeze-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
the Breeze (file_manager) localhost HTTP API as MCP tools. It lets AI agents
that speak MCP — Claude Code, Codex, Gemini CLI, Cursor, etc. — drive Breeze
with structured tool calls instead of shelling out to the `breeze` CLI.

The server is a thin wrapper. It reads `~/.breezefile/api.json` to discover the
Breeze app's port + bearer token, then forwards each tool call to the matching
HTTP endpoint. Auth, validation, and persistence all live in the Breeze app
itself; this process is stateless.

## Install

```bash
cd mcp
npm install
```

That's it. The single runtime dep is `@modelcontextprotocol/sdk`. Node 18+
required (uses built-in `fetch`).

## Wire it into Claude Code

Add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "breeze": {
      "command": "node",
      "args": ["/absolute/path/to/file_manager/mcp/breeze-mcp.mjs"]
    }
  }
}
```

Or, if you've `npm link`'d the package so `breeze-mcp` is on `$PATH`:

```json
{
  "mcpServers": {
    "breeze": {
      "command": "breeze-mcp"
    }
  }
}
```

Restart Claude Code. The tools below will appear under the `breeze` server.

### Optional env vars

- `BREEZE_API_TOKEN` — pin the bearer token explicitly (overrides the value
  read from `~/.breezefile/api.json`).
- `BREEZE_TASK_ID` — default task id used when a tool that takes `id` /
  `task_id` is called without one. Useful when an agent runs inside a single
  task's worktree.

You can set them in the MCP client config:

```json
{
  "mcpServers": {
    "breeze": {
      "command": "node",
      "args": ["/abs/path/mcp/breeze-mcp.mjs"],
      "env": {
        "BREEZE_TASK_ID": "fm-abc"
      }
    }
  }
}
```

## Tools

Read-only:

| Tool | Purpose |
| --- | --- |
| `task_list` | List Breeze tasks. Filters: `status`, `folder`, `pinned`, `search`, `active_only`, `show_completed`. |
| `task_show` | Get full details of a task (defaults to `$BREEZE_TASK_ID`). |
| `tabs_list` | List currently-open tabs in Breeze. |

Mutating:

| Tool | Purpose |
| --- | --- |
| `task_add` | Create a task. `folder` defaults to the parent task's folder when `$BREEZE_TASK_ID` is set. |
| `task_update` | Patch any task field (title, notes, folder, status, dates, pinned). |
| `task_done` | Shortcut for `task_update` with `status=done`. |
| `task_delete` | Delete a task permanently. |
| `app_navigate` | Navigate the active Breeze tab to a folder. |
| `app_open_task_tab` | Open / focus the task tab for a given task. |

## Behaviour notes

- If Breeze isn't running, the MCP server stays up and returns a friendly
  per-call error ("Breeze isn't running — open the app and try again") rather
  than crashing. This matches MCP client expectations (clients tolerate failed
  tool calls but choke on dead servers).
- A one-shot `/healthz` probe runs at startup; failures are logged to stderr
  and don't block the server.
- `~/.breezefile/api.json` is re-read on every tool call, so restarting the
  Breeze app (which picks a new ephemeral port) doesn't require restarting
  the MCP server.
