// Pi coding agent support (task-c4846651004b v1 slice, spike task-6b33298f874b).
//
// Pi (github.com/earendil-works/pi) is an alternate interactive agent the
// operator can spawn instead of Claude Code. This module holds the two pieces
// the shared launcher (runTaskInteractive) needs:
//   - resolvePiBin(): locate the `pi` binary (same probe strategy as
//     resolveClaudeBin — well-known paths, then the user's login shell PATH).
//   - ensurePiMcpConfig(): seed/merge the `typebuild` server entry into
//     ~/.pi/agent/mcp.json so the pi-mcp-adapter extension reaches the
//     TypeBuild MCP server with the SAME env-injected bearer token the Claude
//     path uses (MCP_TOKEN_ENV / TYPEBUILD_MCP_TOKEN). Pi has no native MCP;
//     the adapter (installed as a pi package) reads this file. `auth: "bearer"`
//     is REQUIRED — without it the adapter silently falls into its OAuth
//     discovery path and reports "Re-authentication required" (spike finding).
//
// Pi has NO permission system (no allowlists, no prompts) — its tool calls run
// unrestricted. v1 accepts that for the ad-hoc/dev path; the first-party pi
// extension with a tool_call gate (task-7782ec5b0cca) is the productized
// answer. Session transcripts are plaintext JSONL, so every launch MUST pass
// --no-session (PHI can flow through MCP task bodies mid-session).

import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

let resolvedBin: Promise<string> | null = null;

function probeWellKnown(): string | null {
  if (process.platform === 'win32') {
    const home = os.homedir();
    const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming');
    const candidates = [
      path.join(appData, 'npm', 'pi.cmd'),
      path.join(appData, 'npm', 'pi.exe'),
    ];
    for (const p of candidates) if (existsSync(p)) return p;
    return null;
  }
  const candidates = [
    path.join(os.homedir(), '.local/bin/pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    '/usr/bin/pi',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// An nvm-managed global npm install (the common case on this stack) is only on
// PATH inside a login shell, so mirror resolveClaudeBin's login-shell probe.
function probeLoginShell(): Promise<string | null> {
  return new Promise((resolve) => {
    const loginShell =
      (process.env.SHELL && existsSync(process.env.SHELL) && process.env.SHELL) ||
      (existsSync('/bin/zsh') && '/bin/zsh') ||
      (existsSync('/bin/bash') && '/bin/bash') ||
      '/bin/sh';
    const [cmd, args] =
      process.platform === 'win32'
        ? ['where', ['pi']]
        : [loginShell, ['-lc', 'command -v pi']];
    const c = spawn(cmd, args as string[], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => {
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const p = process.platform === 'win32'
        ? lines.find((l) => existsSync(l.trim())) || ''
        : lines.pop() || '';
      resolve(code === 0 && p && existsSync(p.trim()) ? p.trim() : null);
    });
  });
}

export async function resolvePiBin(): Promise<string> {
  if (resolvedBin) return resolvedBin;
  resolvedBin = (async () => {
    const wk = probeWellKnown();
    if (wk) return wk;
    const ls = await probeLoginShell();
    if (ls) return ls;
    return 'pi';
  })();
  return resolvedBin;
}

/** True when a `pi` binary was actually found (not the bare-name fallback). */
export async function piAvailable(): Promise<boolean> {
  return (await resolvePiBin()) !== 'pi';
}

// The pi-mcp-adapter reads mcp.json from ~/.pi/agent (its "pi global" tier).
// Merge — never clobber — the typebuild entry: the user may have configured
// other servers there. Idempotent; failures are the caller's to degrade on.
export async function ensurePiMcpConfig(): Promise<void> {
  const dir = path.join(os.homedir(), '.pi', 'agent');
  const file = path.join(dir, 'mcp.json');
  // Same server + env-var contract as MCP_INLINE_CONFIG in
  // electron/sources/typebuild.ts — the token rides the PTY env under
  // TYPEBUILD_MCP_TOKEN; only the env-var NAME lands on disk here.
  const entry = {
    url: 'https://general.typebuild.com/mcp',
    auth: 'bearer',
    bearerTokenEnv: 'TYPEBUILD_MCP_TOKEN',
  };
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as typeof config;
  } catch {
    /* absent or unparsable → start fresh */
  }
  const servers = config.mcpServers ?? {};
  const existing = JSON.stringify(servers['typebuild'] ?? null);
  if (existing === JSON.stringify(entry)) return; // already correct
  servers['typebuild'] = entry;
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ ...config, mcpServers: servers }, null, 2) + '\n', 'utf8');
}
