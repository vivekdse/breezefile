// Remote Claude-Code hook bridge.
//
// When `term:spawn` ssh's out to a target, Claude on the remote needs:
//   1. The hook script (`~/.breezefile/claude-hook.sh`) installed on the
//      remote.
//   2. Hook entries in the remote `~/.claude/settings.json`.
//   3. `BREEZE_API_PORT/HOST/TOKEN` env so the hook can POST status.
//   4. A reverse-ssh tunnel mapping the remote-side host:port back to the
//      local api-server.
//
// This module handles (1) and (2) — install once per target, cached by
// script hash. (3) and (4) are added by the term:spawn caller via
// `buildRemoteSpawn`.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { stateDir } from './core/profile.mjs';
import path from 'node:path';
import { HOOK_SCRIPT } from './hooks-register';

const STATE_DIR = stateDir();
const STATE_FILE = path.join(STATE_DIR, 'remote-installs.json');

type State = Record<string, { hash: string; at: number }>;

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}
function saveState(s: State) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function scriptHash(): string {
  return crypto
    .createHash('sha256')
    .update(HOOK_SCRIPT)
    .digest('hex');
}

// Python merger run on the remote. Reads the hook script from argv[1],
// writes it to ~/.breezefile/claude-hook.sh, then merges hook entries
// into ~/.claude/settings.json (preserving foreign keys/events). Echoes
// the script's sha256 on success so the caller can cache.
//
// We use python3 because POSIX `sh` can't safely merge JSON and we don't
// want to assume jq. python3 ships on every modern Linux/macOS by default.
// Build the installer script dynamically so the hook source is embedded
// as base64 — passing it through ssh argv would break on newlines.
function makeInstaller(): string {
  const b64 = Buffer.from(HOOK_SCRIPT, 'utf8').toString('base64');
  return `
import json, os, sys, hashlib, pathlib, base64
home = pathlib.Path.home()
bf = home / ".breezefile"
bf.mkdir(parents=True, exist_ok=True)
hook = bf / "claude-hook.sh"
script = base64.b64decode("${b64}").decode("utf-8")
hook.write_text(script)
hook.chmod(0o755)

claude_dir = home / ".claude"
claude_dir.mkdir(parents=True, exist_ok=True)
sp = claude_dir / "settings.json"
try:
    s = json.loads(sp.read_text()) if sp.exists() else {}
    if not isinstance(s, dict): s = {}
except Exception:
    s = {}

hooks = s.setdefault("hooks", {})
BUSY = 'sh "' + str(hook) + '" busy'
IDLE = 'sh "' + str(hook) + '" idle'
WAITING = 'sh "' + str(hook) + '" waiting'
# task-c926bbe959f6 — unlogged-question backstop, same shape as the local
# hooks-register.ts STOPPED_CMD. Registered as a SECOND command on Stop.
STOPPED = 'sh "' + str(hook) + '" stopped'

def is_breeze(h):
    return isinstance(h, dict) and "claude-hook.sh" in str(h.get("command",""))

def reset(event, cmds):
    if not isinstance(cmds, list):
        cmds = [cmds]
    blocks = hooks.get(event, []) or []
    cleaned = []
    for b in blocks:
        if not isinstance(b, dict): continue
        kept = [h for h in (b.get("hooks") or []) if not is_breeze(h)]
        if kept:
            nb = dict(b); nb["hooks"] = kept; cleaned.append(nb)
    cleaned.append({"hooks":[{"type":"command","command":c} for c in cmds]})
    hooks[event] = cleaned

reset("UserPromptSubmit", BUSY)
reset("Stop", [IDLE, STOPPED])
reset("StopFailure", IDLE)
reset("Notification", WAITING)

sp.write_text(json.dumps(s, indent=2) + "\\n")
h = hashlib.sha256()
h.update(script.encode())
print(h.hexdigest())
`;
}

const inflight = new Map<string, Promise<boolean>>();

/** Install (or confirm cached install of) hooks on a remote ssh target. */
export async function ensureRemoteHooks(target: string): Promise<boolean> {
  const want = scriptHash();
  const state = loadState();
  if (state[target]?.hash === want) return true;
  if (inflight.has(target)) return inflight.get(target)!;
  const p = (async () => {
    try {
      const args = ['-o', 'BatchMode=yes', target, 'python3', '-'];
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let so = '';
        let se = '';
        child.stdout.on('data', (d) => (so += d));
        child.stderr.on('data', (d) => (se += d));
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve(so) : reject(new Error(`ssh exit ${code}: ${se.trim()}`)),
        );
        child.stdin.end(makeInstaller());
      });
      const hash = out.trim().split('\n').pop()?.trim();
      if (hash && hash === want) {
        state[target] = { hash, at: Date.now() };
        saveState(state);
        return true;
      }
      console.warn('[remote-hooks] hash mismatch on', target, hash);
      return false;
    } catch (e) {
      console.warn('[remote-hooks] install failed for', target, (e as Error).message);
      return false;
    }
  })();
  inflight.set(target, p);
  try {
    return await p;
  } finally {
    inflight.delete(target);
  }
}

/** Read local api.json so we can plumb the port+token into the remote. */
export function readLocalApi(): { port: number; token: string } | null {
  try {
    const raw = readFileSync(path.join(STATE_DIR, 'api.json'), 'utf8');
    const j = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof j.port === 'number' && typeof j.token === 'string') {
      return { port: j.port, token: j.token };
    }
  } catch {
    /* not running / no file */
  }
  return null;
}

/** Pick a stable remote port per breezefile-run so concurrent tabs to
 *  the same host share the tunnel (the 2nd ssh's `-R` silently no-ops
 *  if the port is already bound). Changes across breezefile restarts
 *  because the local api port changes too. */
export function pickRemotePort(apiPort: number): number {
  return 49152 + (apiPort % 8192);
}
