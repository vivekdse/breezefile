// fm-z7v — register Claude Code hooks into ~/.claude/settings.json so
// every claude session reports busy/idle to the running file_manager
// over the localhost api-server. UserPromptSubmit → busy, Stop /
// StopFailure → idle. Hook payload binds to a specific tab via
// $BREEZE_PTY_ID, an env var the pty layer injects at spawn time.
//
// Hooks fail silently when BREEZE_PTY_ID is unset (claude run from
// outside file_manager) or when ~/.breezefile/api.json is missing
// (file_manager not running) — they never block a turn.
//
// The actual POST is done by a small shell script we drop at
// ~/.breezefile/claude-hook.sh on every launch. Inlining the curl+JSON
// parsing into settings.json works but the multi-layer quoting (sh
// inside JSON, python inside sh) is hostile to maintenance, so we keep
// settings.json terse and own the logic in one file.

import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';

type HookEntry = { type?: 'command'; command: string };
type HookMatcher = { matcher?: string; hooks: HookEntry[] };
type ClaudeSettings = {
  hooks?: Record<string, HookMatcher[]>;
  [k: string]: unknown;
};

function settingsPath(): string {
  // Hooks live in ~/.claude/settings.json (NOT ~/.claude.json — that
  // file holds MCP servers per fm-fc0).
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function backupPath(): string {
  return settingsPath() + '.bak';
}

function hookScriptPath(): string {
  return path.join(os.homedir(), '.breezefile', 'claude-hook.sh');
}

const HOOK_SCRIPT = `#!/bin/sh
# fm-z7v — Claude Code hook → file_manager bridge.
# Argv: $1 = busy|idle. Reads $BREEZE_PTY_ID from env, ~/.breezefile/api.json
# for port+token. Silently no-ops when either is missing so claude turns
# never block on a stopped/absent file_manager.
set -e
state="\${1:-}"
[ "$state" = "busy" ] || [ "$state" = "idle" ] || exit 0
[ -n "\${BREEZE_PTY_ID:-}" ] || exit 0
api="$HOME/.breezefile/api.json"
[ -f "$api" ] || exit 0
# Tiny JSON pluck. The api.json keys are well-known and never contain
# escape sequences, so a quoted-string regex is safe and avoids a
# python/jq dependency.
port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$api" | head -n1)
tok=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$api" | head -n1)
[ -n "$port" ] && [ -n "$tok" ] || exit 0
curl -s -m 1 -X POST \\
  -H "Authorization: Bearer $tok" \\
  -H "Content-Type: application/json" \\
  --data "{\\"pty_id\\":$BREEZE_PTY_ID,\\"state\\":\\"$state\\"}" \\
  "http://127.0.0.1:$port/claude-state" >/dev/null 2>&1 || true
`;

function writeHookScript() {
  const p = hookScriptPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, HOOK_SCRIPT, 'utf8');
  try {
    chmodSync(p, 0o755);
  } catch {
    /* non-fatal on Windows */
  }
}

function readSettings(): ClaudeSettings | null {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    console.warn('[hooks-register] failed to parse', p, (e as Error).message);
    return null;
  }
}

function writeSettings(s: ClaudeSettings, originalExisted: boolean) {
  const p = settingsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (originalExisted && !existsSync(backupPath())) {
    try {
      copyFileSync(p, backupPath());
    } catch {
      /* non-fatal */
    }
  }
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

const SCRIPT = hookScriptPath();
const BUSY_CMD = `sh "${SCRIPT}" busy`;
const IDLE_CMD = `sh "${SCRIPT}" idle`;

// Absolute path to the bundled `breeze` launcher. Used for SessionStart
// and PreCompact hooks that emit cross-folder task context to Claude
// Code via `breeze prime`. Matches the resolution pattern in ipc.ts's
// sharerPath(): packaged → process.resourcesPath; dev → repo bin/.
function breezeBinPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'breeze')
    : path.join(app.getAppPath(), 'bin', 'breeze');
}

// We own any hook entry whose command runs claude-hook.sh OR
// `breeze prime` — re-register replaces them rather than appending so
// idempotency holds even when we evolve the command shape (e.g. the
// breeze launcher path changes between dev and packaged builds).
function isBreezeHook(h: HookEntry): boolean {
  if (typeof h.command !== 'string') return false;
  return h.command.includes('claude-hook.sh') || /\bbreeze\b.*\bprime\b/.test(h.command);
}

function withoutBreezeMatchers(blocks: HookMatcher[] | undefined): HookMatcher[] {
  if (!blocks) return [];
  const cleaned: HookMatcher[] = [];
  for (const b of blocks) {
    const kept = (b.hooks ?? []).filter((h) => !isBreezeHook(h));
    if (kept.length > 0) cleaned.push({ ...b, hooks: kept });
  }
  return cleaned;
}

export function registerBreezeHooks(): 'written' | 'unchanged' | 'error' {
  try {
    writeHookScript();
  } catch (e) {
    console.warn('[hooks-register] script write failed:', (e as Error).message);
    return 'error';
  }

  const existed = existsSync(settingsPath());
  const settings = readSettings();
  if (settings === null) return 'error';

  const oldHooks = settings.hooks ?? {};
  const nextHooks: Record<string, HookMatcher[]> = {};
  // Preserve foreign hook events; strip + re-add ours.
  for (const event of Object.keys(oldHooks)) {
    nextHooks[event] = withoutBreezeMatchers(oldHooks[event]);
  }
  for (const event of [
    'UserPromptSubmit',
    'Stop',
    'StopFailure',
    'SessionStart',
    'PreCompact',
  ]) {
    if (!nextHooks[event]) nextHooks[event] = [];
  }
  nextHooks.UserPromptSubmit.push({
    hooks: [{ type: 'command', command: BUSY_CMD }],
  });
  nextHooks.Stop.push({
    hooks: [{ type: 'command', command: IDLE_CMD }],
  });
  nextHooks.StopFailure.push({
    hooks: [{ type: 'command', command: IDLE_CMD }],
  });

  // SessionStart + PreCompact run `breeze prime` so Claude gets active
  // task context at session boot and again after compaction. Path is
  // absolute (not bare `breeze`) so the hook works even when the user's
  // shell PATH doesn't include the brew/dev install location.
  const PRIME_CMD = `"${breezeBinPath()}" prime`;
  nextHooks.SessionStart.push({
    matcher: '',
    hooks: [{ type: 'command', command: PRIME_CMD }],
  });
  nextHooks.PreCompact.push({
    matcher: '',
    hooks: [{ type: 'command', command: PRIME_CMD }],
  });

  if (JSON.stringify(oldHooks) === JSON.stringify(nextHooks)) {
    return 'unchanged';
  }

  const next: ClaudeSettings = { ...settings, hooks: nextHooks };
  try {
    writeSettings(next, existed);
    return 'written';
  } catch (e) {
    console.warn('[hooks-register] write failed:', (e as Error).message);
    return 'error';
  }
}
