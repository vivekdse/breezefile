import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArrangeRect, ArrangeResult, Capabilities, PlatformAdapter } from './index';
import { bfsSearch } from './bfs';
import * as indexDb from './index-db';

// Windows adapter. Like Linux, Windows has no always-on metadata index we can
// query for free (Windows Search exists but is unreliable / often disabled),
// so we reuse the shared SQLite name index at ~/.breezefile/index.db plus a
// live BFS for the cold-start query — the exact strategy LinuxAdapter uses.
//
// Most macOS-only capabilities (colorTags, quickLook, share, vibrancy,
// dockBadge) are off — the renderer hides those verbs. windowArrange is
// supported through the Win32 API driven from a one-shot PowerShell snippet
// (no native module, no extra dependency), so TypeBuild side-by-side works.
export class WindowsAdapter implements PlatformAdapter {
  readonly id = 'windows' as const;
  private rebuildKicked = false;

  capabilities(): Capabilities {
    return {
      // No free OS metadata index on Windows that we can rely on; our own
      // SQLite index backs the search verb (see searchByIndex).
      spotlightSearch: false,
      // Sidebar enumerates non-system drive letters (see windowsDriveLocations).
      externalVolumes: true,
      cloudMounts: false,
      attentionSound: true,
      // Windows shows a taskbar overlay badge rather than a dock badge.
      // app.dock is undefined on Windows; the renderer's badge path no-ops
      // gracefully, so leave this false until an overlay-icon impl lands.
      dockBadge: false,
      share: false,
      colorTags: false,
      quickLook: false,
      // TODO: ftype/assoc-based "Open With" launcher. shell.openPath covers
      // the default-app case already.
      openWithLauncher: false,
      vibrancy: false,
      // Win32 SetWindowPos lets us move any top-level window we can find by
      // process name, driven from PowerShell — no special permission needed.
      windowArrange: true,
    };
  }

  private kickRebuildOnce() {
    if (this.rebuildKicked) return;
    this.rebuildKicked = true;
    indexDb.rebuild().catch((e) => {
      console.warn('[index] rebuild failed:', (e as Error).message);
    });
  }

  async searchFolders(tokens: string[], limit: number): Promise<string[]> {
    return this.searchInternal(tokens, limit, true);
  }

  async searchByIndex(tokens: string[], limit: number): Promise<string[]> {
    return this.searchInternal(tokens, limit, false);
  }

  private async searchInternal(
    tokens: string[],
    limit: number,
    dirsOnly: boolean,
  ): Promise<string[]> {
    if (indexDb.isEmpty()) {
      this.kickRebuildOnce();
      return bfsSearch({
        roots: [os.homedir()],
        tokens,
        limit,
        maxDepth: 6,
        dirsOnly,
      });
    }
    const STALE_MS = 6 * 60 * 60 * 1000;
    if (Date.now() - indexDb.getLastBuildMs() > STALE_MS) {
      this.kickRebuildOnce();
    }
    return indexDb.search(tokens, limit, dirsOnly);
  }

  playAttentionSound(): void {
    // Asterisk is the standard Windows attention chime. PowerShell's
    // SystemSounds avoids bundling an asset.
    try {
      spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      ).unref();
    } catch {
      /* best-effort */
    }
  }

  async chromePath(): Promise<string | null> {
    // Chrome's standard install locations on Windows. ProgramFiles /
    // ProgramFiles(x86) / per-user LocalAppData cover the common cases.
    const candidates = [
      process.env['PROGRAMFILES'] &&
        path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] &&
        path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['LOCALAPPDATA'] &&
        path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter((p): p is string => typeof p === 'string');
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  async canArrangeWindows(): Promise<'ok' | 'no-permission' | 'unsupported'> {
    // SetWindowPos works for any normal desktop window; no grant needed.
    return 'ok';
  }

  // Position the most-recently-active Chrome window into `rect` via the Win32
  // API. We P/Invoke ShowWindow (restore, in case it's maximized) +
  // SetWindowPos from a one-shot PowerShell snippet, targeting the Chrome
  // process whose MainWindowHandle is non-zero — that is the foreground
  // top-level window, never every Chrome window.
  async arrangeChromeLeft(rect: ArrangeRect): Promise<ArrangeResult> {
    const { x, y, width, height } = rect;
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no-chrome-window'; exit 0 }
$h = $p.MainWindowHandle
# SW_RESTORE = 9 — clear maximized so the move/resize is honored.
[W]::ShowWindow($h, 9) | Out-Null
# SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10) = 0x14
[W]::SetWindowPos($h, [IntPtr]::Zero, ${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)}, ${Math.round(height)}, 0x14) | Out-Null
Write-Output 'ok'
`.trim();
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 6000, windowsHide: true },
        (err, stdout) => {
          if (err) { resolve({ ok: false, reason: 'no-chrome-window' }); return; }
          if (/no-chrome-window/.test(stdout || '')) {
            resolve({ ok: false, reason: 'no-chrome-window' });
          } else {
            resolve({ ok: true });
          }
        },
      );
    });
  }
}
