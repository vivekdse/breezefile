// TypeBuild prerequisite detection (bead fm-b5at.3).
//
// Self-contained module: resolves the `claude` binary and Google Chrome so
// the onboarding checklist can tell the user what's missing and offer a
// one-click install of Claude Code. Final wiring into main/ipc/settings
// happens in a later integration bead — see registerTypebuildDetectIpc().

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { platform } from '../platform';

// GUI apps launched from Dock/Finder/Spotlight get a minimal PATH that omits
// ~/.local/bin, Homebrew, nvm shims, etc., so a bare `claude` ENOENTs. We
// mirror electron/agents/claude.ts: probe well-known locations, then fall
// back to a login-shell `command -v claude` so the user's profile loads PATH.
// The result (absolute path or null) is cached in memory; recheckClaude busts
// it.
let claudeCache: Promise<string | null> | null = null;

function probeWellKnown(): string | null {
  if (process.platform === 'win32') {
    const home = os.homedir();
    const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    const candidates = [
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(appData, 'npm', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.exe'),
    ];
    for (const p of candidates) if (existsSync(p)) return p;
    return null;
  }
  const candidates = [
    // Canonical Claude Code local install (the official install.sh target).
    // This is commonly only reachable via a shell alias, which a
    // non-interactive `command -v claude` can't see — so probe the path
    // directly or we'd wrongly prompt the user to re-install.
    path.join(os.homedir(), '.claude/local/claude'),
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function probeLoginShell(): Promise<string | null> {
  return new Promise((resolve) => {
    // Windows GUI apps inherit the system PATH; `where` resolves the global
    // install directly. POSIX: -l so the profile loads PATH; $SHELL or zsh.
    const isWin = process.platform === 'win32';
    const [cmd, args] = isWin
      ? ['where', ['claude']]
      : [process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude']];
    const c = spawn(cmd, args as string[], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: isWin,
    });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => {
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const p = isWin
        ? lines.find((l) => existsSync(l.trim())) || ''
        : lines.pop() || '';
      resolve(code === 0 && p && existsSync(p.trim()) ? p.trim() : null);
    });
  });
}

/** Absolute path to the `claude` binary, or null if not found. Cached. */
export function resolveClaudeBinary(): Promise<string | null> {
  if (claudeCache) return claudeCache;
  claudeCache = (async () => {
    const wk = probeWellKnown();
    if (wk) return wk;
    return probeLoginShell();
  })();
  return claudeCache;
}

/** Bust the cache and re-resolve (e.g. after a one-click install). */
export function recheckClaude(): Promise<string | null> {
  claudeCache = null;
  return resolveClaudeBinary();
}

/** Absolute path to Google Chrome / Chromium, or null. Via PlatformAdapter. */
export function detectChrome(): Promise<string | null> {
  return platform().chromePath();
}

export type Checks = {
  claude: { ok: boolean; path?: string };
  chrome: { ok: boolean; path?: string };
};

/** Run both detections and report presence + resolved paths. */
export async function getChecks(): Promise<Checks> {
  const [claude, chrome] = await Promise.all([
    resolveClaudeBinary(),
    detectChrome(),
  ]);
  return {
    claude: claude ? { ok: true, path: claude } : { ok: false },
    chrome: chrome ? { ok: true, path: chrome } : { ok: false },
  };
}

/**
 * Shell command that installs Claude Code. Run by the integration bead in an
 * embedded terminal tab so the user sees progress; this module only supplies
 * the string. Official installer first, documented npm-global fallback if the
 * installer isn't reachable.
 */
export function installClaudeCommand(): string {
  // The curl|bash installer is POSIX-only. On Windows the supported path is
  // the npm-global install (or the PowerShell installer), so surface that.
  if (process.platform === 'win32') {
    return 'npm install -g @anthropic-ai/claude-code';
  }
  return (
    'curl -fsSL https://claude.ai/install.sh | bash ' +
    '|| npm install -g @anthropic-ai/claude-code'
  );
}

/**
 * Register the detect IPC handlers. EXPORTED BUT NOT CALLED ANYWHERE YET — the
 * integration bead wires this into electron/main.ts (or ipc.ts) once the
 * parallel work on those files lands. Adding a call here would collide with
 * agents currently editing main.ts/ipc.ts.
 */
export function registerTypebuildDetectIpc(): void {
  ipcMain.handle('typebuild:detect:checks', () => getChecks());
  ipcMain.handle('typebuild:detect:installCommand', () => installClaudeCommand());
}
