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
    // -l so the user's profile loads PATH (.zshrc/.bash_profile). $SHELL is
    // the user's login shell; fall back to zsh if unset.
    const shell = process.env.SHELL || '/bin/zsh';
    const c = spawn(shell, ['-lc', 'command -v claude'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => {
      const p = out.trim().split('\n').pop() || '';
      resolve(code === 0 && p && existsSync(p) ? p : null);
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
