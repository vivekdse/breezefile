// fm-at5 — strip a stale breeze-mcp registration from the user-level Claude
// config. The breeze-mcp server has been removed; this remains so users who
// registered it on an earlier build can cleanly remove the leftover
// `mcpServers.breeze` entry from ~/.claude.json (via the
// `claude:unregister-mcp` IPC / Settings reset).

import path from 'node:path';
import os from 'node:os';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from 'node:fs';

type ClaudeMcpEntry = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type ClaudeSettings = {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  [k: string]: unknown;
};

function settingsPath(): string {
  // Claude Code reads MCP config from ~/.claude.json, NOT
  // ~/.claude/settings.json (settings.json holds permissions/hooks/env
  // and is loaded separately). Verified empirically: `claude mcp add`
  // writes to ~/.claude.json and `claude mcp list` reads from there.
  return path.join(os.homedir(), '.claude.json');
}

function backupPath(): string {
  return settingsPath() + '.bak';
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

/** Remove the breeze entry — used to strip a stale registration left by an
 *  earlier build. Leaves other mcpServers entries intact and drops an empty
 *  mcpServers object. */
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
