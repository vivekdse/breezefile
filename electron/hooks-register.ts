// fm-z7v — register Claude Code hooks into ~/.claude/settings.json so
// every claude session reports busy/idle to the running file_manager
// over the localhost api-server. UserPromptSubmit → busy, Stop /
// StopFailure / Notification → idle. Notification fires whenever Claude
// needs the user (permission prompt, idle-input warning) — without it,
// the tab stays green while Claude is silently waiting for an answer
// behind a permission dialog. Hook payload binds to a specific tab via
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
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { withoutBreezeMatchers } from './hooks-register-core.mjs';

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

export const HOOK_SCRIPT = `#!/bin/sh
# fm-z7v — Claude Code hook → file_manager bridge.
# Argv: $1 = busy|idle|waiting|stopped.
#   busy    — UserPromptSubmit (turn started)
#   idle    — Stop / StopFailure (turn ended cleanly or with an error)
#   waiting — Notification (mid-turn permission prompt or 60s idle warning)
#   stopped — Stop (session end) BACKSTOP for unlogged questions
#             (task-c926bbe959f6). Fires alongside 'idle' on Stop; unlike
#             'idle' (which is pty-tinting only) it forwards the task
#             binding + Claude Code's transcript_path so the app can
#             detect a session that stopped on a still-in_progress task
#             without formally advancing it — i.e. probably asked a
#             plain-text question and just ended, which the structured
#             ask_user attention path would otherwise never see. This is
#             the Claude-Code lifecycle ADAPTER onto the provider-agnostic
#             ask_user protocol; a different runtime supplies its own hook.
# 'waiting' is distinct from 'idle' so the renderer can banner mid-turn
# attention requests even when the user is staring at the Claude tab —
# end-of-turn Stop signals get the polite "you're already looking at it"
# suppression, but a permission prompt is easy to miss in a stream of
# diff output and earns a banner regardless. Reads $BREEZE_PTY_ID from
# env, ~/.breezefile/api.json for port+token. Silently no-ops when
# either is missing so claude turns never block on a stopped/absent
# file_manager.
set -e
log="$HOME/.breezefile/claude-hook.log"
ts=$(date '+%H:%M:%S')
state="\${1:-}"
echo "[$ts] argv=$state pty=\${BREEZE_PTY_ID:-<unset>} ppid=$PPID" >>"$log"
[ "$state" = "busy" ] || [ "$state" = "idle" ] || [ "$state" = "waiting" ] || [ "$state" = "stopped" ] || { echo "  bad state, exit" >>"$log"; exit 0; }
# The 'stopped' backstop needs a task binding to be useful. It is set on
# task-bound interactive sessions (BREEZE_TASK_ID) — a plain 'claude' in a
# shell tab has neither, so the backstop no-ops there. pty tinting states
# still require BREEZE_PTY_ID.
if [ "$state" = "stopped" ]; then
  [ -n "\${BREEZE_TASK_ID:-}" ] || { echo "  stopped: no task binding, exit" >>"$log"; exit 0; }
else
  [ -n "\${BREEZE_PTY_ID:-}" ] || { echo "  pty unset, exit" >>"$log"; exit 0; }
fi
api="$HOME/.breezefile/api.json"
# Env vars win over api.json — the remote-hook path injects them via ssh
# and has no api.json. Locally, env is unset and we fall through to the
# file.
host="\${BREEZE_API_HOST:-127.0.0.1}"
port="\${BREEZE_API_PORT:-}"
tok="\${BREEZE_API_TOKEN:-}"
if [ -z "$port" ] || [ -z "$tok" ]; then
  [ -f "$api" ] || { echo "  api.json missing and env unset, exit" >>"$log"; exit 0; }
  port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$api" | head -n1)
  tok=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$api" | head -n1)
fi
[ -n "$port" ] && [ -n "$tok" ] || { echo "  port/tok parse failed, exit" >>"$log"; exit 0; }
if [ "$state" = "stopped" ]; then
  # Stop hooks receive a JSON payload on STDIN carrying session_id and
  # transcript_path. We read it best-effort and extract those two fields
  # with sed (no jq dependency, same convention as the api.json parse
  # above). transcript_path is a FILESYSTEM POINTER, not content — the app
  # reads (and never persists) the transcript; we never echo transcript
  # BODY here, so no PHI touches this log or argv. task_id rides from the
  # BREEZE_TASK_ID env the interactive spawn injected, and source_id from
  # BREEZE_SOURCE_ID so the app routes to the right TaskSource.
  payload=$(cat 2>/dev/null || echo '')
  sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)
  tpath=$(printf '%s' "$payload" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)
  echo "  STOPPED task=$BREEZE_TASK_ID src=\${BREEZE_SOURCE_ID:-<unset>} sid=$sid host=$host port=$port" >>"$log"
  http=$(curl -s -m 2 -o /dev/null -w '%{http_code}' -X POST \\
    -H "Authorization: Bearer $tok" \\
    -H "Content-Type: application/json" \\
    --data "{\\"task_id\\":\\"$BREEZE_TASK_ID\\",\\"source_id\\":\\"\${BREEZE_SOURCE_ID:-}\\",\\"session_id\\":\\"$sid\\",\\"transcript_path\\":\\"$tpath\\"}" \\
    "http://$host:$port/claude-stopped" 2>>"$log" || echo "curl-fail")
  echo "  http=$http" >>"$log"
  exit 0
fi
echo "  POST pty=$BREEZE_PTY_ID state=$state host=$host port=$port" >>"$log"
http=$(curl -s -m 1 -o /dev/null -w '%{http_code}' -X POST \\
  -H "Authorization: Bearer $tok" \\
  -H "Content-Type: application/json" \\
  --data "{\\"pty_id\\":$BREEZE_PTY_ID,\\"state\\":\\"$state\\"}" \\
  "http://$host:$port/claude-state" 2>>"$log" || echo "curl-fail")
echo "  http=$http" >>"$log"
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
const WAITING_CMD = `sh "${SCRIPT}" waiting`;
// task-c926bbe959f6 — the Stop backstop for unlogged questions. Runs on the
// SAME Stop event as IDLE_CMD, but forwards the task binding + transcript_path
// to /claude-stopped. Claude Code pipes the Stop payload JSON to every hook
// command's stdin, so this command gets session_id/transcript_path without any
// extra wiring. Kept as a SEPARATE entry from IDLE_CMD so the pty-tint path and
// the backstop path evolve independently.
const STOPPED_CMD = `sh "${SCRIPT}" stopped`;

// isBreezeHook / withoutBreezeMatchers live in hooks-register-core.mjs (a
// plain-ESM sibling, no Electron/fs) so the task-8997b15a37d9 stale-hook
// migration logic is unit-testable without a TS transpile step — same split
// convention as claude-stop-backstop.mjs / credential-normalize.mjs.

export function registerBreezeHooks(): 'written' | 'unchanged' | 'error' | 'skipped' {
  // The hook bridge is a POSIX `sh` script invoked as `sh "${SCRIPT}" <arg>`.
  // That can't run on Windows, and registering it would pollute the user's
  // ~/.claude/settings.json with hooks that error every turn. Skip cleanly —
  // the busy/idle tab tint is a degraded feature on Windows, not a crash.
  if (process.platform === 'win32') return 'skipped';
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
  // Preserve foreign hook events; strip + re-add ours. An event we don't own
  // (e.g. the retired SessionStart `breeze prime` hook) that cleans out to
  // empty is dropped entirely rather than left as a dangling `"Event": []` —
  // mirrors unregisterBreezeHooks below.
  for (const event of Object.keys(oldHooks)) {
    const cleaned = withoutBreezeMatchers(oldHooks[event]);
    if (cleaned.length > 0) nextHooks[event] = cleaned;
  }
  for (const event of [
    'UserPromptSubmit',
    'Stop',
    'StopFailure',
    'Notification',
  ]) {
    if (!nextHooks[event]) nextHooks[event] = [];
  }
  nextHooks.UserPromptSubmit.push({
    hooks: [{ type: 'command', command: BUSY_CMD }],
  });
  // Two commands on Stop: IDLE_CMD flips the pty tint; STOPPED_CMD is the
  // unlogged-question backstop (task-c926bbe959f6). Both receive the Stop
  // payload on stdin; only STOPPED_CMD reads it.
  nextHooks.Stop.push({
    hooks: [
      { type: 'command', command: IDLE_CMD },
      { type: 'command', command: STOPPED_CMD },
    ],
  });
  nextHooks.StopFailure.push({
    hooks: [{ type: 'command', command: IDLE_CMD }],
  });
  // Notification fires when Claude needs user input mid-turn (permission
  // prompt, 60s idle warning). We send 'waiting' (not 'idle') so the
  // renderer can distinguish mid-turn attention requests from end-of-
  // turn Stop. Both flip the tab red, but 'waiting' bypasses the
  // "you're already on this tab" banner suppression — permission
  // prompts get easily lost in scrolling TUI output, so the user wants
  // the system notification regardless of where they're looking.
  nextHooks.Notification.push({
    hooks: [{ type: 'command', command: WAITING_CMD }],
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

// fm-at5 — inverse of registerBreezeHooks: strip every Breeze-owned hook
// entry from ~/.claude/settings.json (matched by isBreezeHook) and delete
// the dropped ~/.breezefile/claude-hook.sh. Idempotent: 'absent' when there
// was nothing of ours to remove. Foreign hooks/events are preserved; an
// event we empty out is dropped so we don't leave dangling `"Stop": []`.
export function unregisterBreezeHooks(): 'removed' | 'absent' | 'error' {
  const existed = existsSync(settingsPath());
  const scriptExists = existsSync(hookScriptPath());
  const settings = existed ? readSettings() : {};
  if (settings === null) return 'error';

  const oldHooks = settings.hooks ?? {};
  const nextHooks: Record<string, HookMatcher[]> = {};
  for (const event of Object.keys(oldHooks)) {
    const cleaned = withoutBreezeMatchers(oldHooks[event]);
    if (cleaned.length > 0) nextHooks[event] = cleaned;
  }
  const hooksChanged = JSON.stringify(oldHooks) !== JSON.stringify(nextHooks);

  // Nothing of ours anywhere → already absent.
  if (!hooksChanged && !scriptExists) return 'absent';

  try {
    if (hooksChanged) {
      const next: ClaudeSettings = { ...settings };
      if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
      else delete next.hooks;
      writeSettings(next, existed);
    }
    if (scriptExists) {
      try {
        unlinkSync(hookScriptPath());
      } catch {
        /* best-effort: settings already cleaned */
      }
    }
    return 'removed';
  } catch (e) {
    console.warn('[hooks-register] unregister failed:', (e as Error).message);
    return 'error';
  }
}
