// fm-fc0 — register breeze-mcp into the user-level Claude config so any
// AI session (task-bound or not) can call Breeze tools natively.
//
// User-level only — we never touch per-project .claude/ directories
// because that would scatter Breeze references across the user's repos.
// One global registration is enough; the MCP server itself reads
// ~/.breezefile/api.json on every call so it stays in sync with whichever
// Breeze process is currently running.

import path from 'node:path';
import os from 'node:os';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { app } from 'electron';

type ClaudeMcpEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type ClaudeSettings = {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  [k: string]: unknown;
};

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function backupPath(): string {
  return settingsPath() + '.bak';
}

/** Resolve the bundled breeze-mcp.mjs path. In dev this lives next to
 *  the app source; in a packaged build electron-builder copies the mcp/
 *  directory into resources. We search both locations and return the
 *  first that exists. */
function resolveMcpPath(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'mcp', 'breeze-mcp.mjs'),
    path.join(process.resourcesPath ?? '', 'app', 'mcp', 'breeze-mcp.mjs'),
    path.join(process.resourcesPath ?? '', 'mcp', 'breeze-mcp.mjs'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function readSettings(): ClaudeSettings | null {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    console.warn('[mcp-register] failed to parse', p, (e as Error).message);
    return null;
  }
}

function writeSettings(s: ClaudeSettings, originalExisted: boolean) {
  const p = settingsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Backup original on first modification (only when there *was* an
  // original — never write an empty backup).
  if (originalExisted && !existsSync(backupPath())) {
    try {
      copyFileSync(p, backupPath());
    } catch {
      /* non-fatal */
    }
  }
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

function entriesEqual(a: ClaudeMcpEntry, b: ClaudeMcpEntry): boolean {
  if (a.command !== b.command) return false;
  if (JSON.stringify(a.args ?? []) !== JSON.stringify(b.args ?? [])) return false;
  // env intentionally not compared — token rotates per launch and the
  // MCP server reads from api.json by default; we don't pin a token here.
  return true;
}

/** Idempotent: register breeze under mcpServers.breeze if missing or stale.
 *  Returns one of:
 *   'written'   — new entry added or stale entry replaced
 *   'unchanged' — entry already correct
 *   'no-mcp'    — couldn't locate breeze-mcp.mjs (silent skip)
 *   'error'     — read/parse/write failure
 */
export function registerBreezeMcp(): 'written' | 'unchanged' | 'no-mcp' | 'error' {
  const mcpPath = resolveMcpPath();
  if (!mcpPath) return 'no-mcp';

  const desired: ClaudeMcpEntry = {
    command: 'node',
    args: [mcpPath],
  };

  const existed = existsSync(settingsPath());
  const settings = readSettings();
  if (settings === null) return 'error';

  const current = settings.mcpServers?.breeze;
  if (current && entriesEqual(current, desired)) return 'unchanged';

  const next: ClaudeSettings = {
    ...settings,
    mcpServers: {
      ...(settings.mcpServers ?? {}),
      breeze: desired,
    },
  };

  try {
    writeSettings(next, existed);
    return 'written';
  } catch (e) {
    console.warn('[mcp-register] write failed:', (e as Error).message);
    return 'error';
  }
}

/** Remove the breeze entry — used when the user disables auto-registration
 *  or task management. Leaves other mcpServers entries intact. */
export function unregisterBreezeMcp(): 'removed' | 'absent' | 'error' {
  const existed = existsSync(settingsPath());
  if (!existed) return 'absent';
  const settings = readSettings();
  if (settings === null) return 'error';
  if (!settings.mcpServers?.breeze) return 'absent';

  const next: ClaudeSettings = { ...settings, mcpServers: { ...settings.mcpServers } };
  delete next.mcpServers!.breeze;
  if (Object.keys(next.mcpServers ?? {}).length === 0) {
    next.mcpServers = undefined;
  }
  try {
    writeSettings(next, existed);
    return 'removed';
  } catch {
    return 'error';
  }
}
