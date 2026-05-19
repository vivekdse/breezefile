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
import { app } from 'electron';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
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

export const HOOK_SCRIPT = `#!/bin/sh
# fm-z7v — Claude Code hook → file_manager bridge.
# Argv: $1 = busy|idle|waiting.
#   busy    — UserPromptSubmit (turn started)
#   idle    — Stop / StopFailure (turn ended cleanly or with an error)
#   waiting — Notification (mid-turn permission prompt or 60s idle warning)
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
[ "$state" = "busy" ] || [ "$state" = "idle" ] || [ "$state" = "waiting" ] || { echo "  bad state, exit" >>"$log"; exit 0; }
[ -n "\${BREEZE_PTY_ID:-}" ] || { echo "  pty unset, exit" >>"$log"; exit 0; }
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

// Absolute path to the bundled `breeze` launcher. Used for SessionStart
// and PreCompact hooks that emit cross-folder task context to Claude
// Code via `breeze prime`. Matches the resolution pattern in ipc.ts's
// sharerPath(): packaged → process.resourcesPath; dev → repo bin/.
function breezeBinPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'breeze')
    : path.join(app.getAppPath(), 'bin', 'breeze');
}

// Put `breeze` on the user's PATH automatically, on every launch, so
// `breeze` works from any shell without a manual ./cli/install.sh step
// — for both `npm run dev` (source) and the packaged .app (cask).
// Idempotent: symlink ~/.local/bin/breeze → breezeBinPath() (the POSIX
// shim, which itself resolves a Node runtime). This is the in-app
// equivalent of cli/install.sh and the single source of truth for how
// the launcher reaches the user's PATH.
//
// ~/.local/bin is the right target on both macOS and Linux: it's the
// XDG-ish per-user bin dir, needs no sudo, and is on PATH in typical
// shell setups. We never write to /usr/local/bin (would need sudo and
// is system-global). Best-effort: any failure is returned, not thrown,
// so it can never block startup.
function localBinDir(): string {
  return path.join(os.homedir(), '.local', 'bin');
}

export function ensureBreezeCli():
  | 'written'
  | 'unchanged'
  | 'missing-source'
  | 'error' {
  try {
    const src = breezeBinPath();
    if (!existsSync(src)) return 'missing-source';

    const dir = localBinDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const link = path.join(dir, 'breeze');

    // Already a symlink pointing exactly where we want → nothing to do.
    let existing: { isLink: boolean; target?: string } = { isLink: false };
    try {
      if (lstatSync(link).isSymbolicLink()) {
        existing = { isLink: true, target: readlinkSync(link) };
      } else if (existsSync(link)) {
        // A real file (or non-symlink) is squatting the name. Don't
        // clobber something the user may have put there deliberately.
        return 'error';
      }
    } catch {
      /* link doesn't exist yet — fall through to create it */
    }
    if (existing.isLink && existing.target === src) return 'unchanged';
    if (existing.isLink) unlinkSync(link); // stale/wrong target → replace

    symlinkSync(src, link);

    // Surface (log only) when the dir we just linked into isn't on PATH,
    // mirroring cli/install.sh's note — the symlink is useless otherwise.
    const onPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .includes(dir);
    if (!onPath) {
      console.warn(
        `[breeze-cli] linked ${link} but ${dir} is not on PATH; ` +
          `add it to your shell rc to use the \`breeze\` command.`,
      );
    }
    return 'written';
  } catch (e) {
    console.warn('[breeze-cli] ensureBreezeCli failed:', (e as Error).message);
    return 'error';
  }
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
    'Notification',
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
