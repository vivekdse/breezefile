// Server-hosted operator instructions (task-7bc1f1dfc202).
//
// The browser playbook — the standing, NON-PHI guidance the agent operates by —
// used to live ONLY in code (the hardcoded playbook in electron/browser/
// automation.ts) plus an optional per-machine cloud.md. That made the playbook
// drift across machines and impossible to update without a client release.
//
// It now leads with ONE GLOBAL doc fetched from the server at session start:
//   GET /chromeext/operator-instructions?scope=global
//     → { scope, version, body, updated_by, created_at }
//       (version 0 / empty body when nothing has been set yet)
// We fetch it in MAIN (Firebase-authed via typebuildFetch), inject it into the
// launched `claude` session, and CACHE it on disk so an offline launch still
// gets the last-synced copy. The server is canonical; cloud.md is retired as the
// source of truth (its cache is only an offline fallback).
//
// SCOPE. We lead with `global` per the epic's decision. The signature takes a
// scope so a later layering pass (org → project → machine) can stack docs
// without touching callers.
//
// NON-PHI: operator instructions are standing guidance / selectors / paths /
// code — never a patient value. The server PHI-guards writes (422). We never log
// the body.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { API_BASE, typebuildFetch } from './task-data';

/** On-disk cache of the last-synced operator instructions, by scope. Override the
 *  root with $BREEZE_MEMORY_DIR (tests). This is the OFFLINE fallback only. */
function cacheFile(scope: string): string {
  const root = process.env.BREEZE_MEMORY_DIR || path.join(os.homedir(), '.breezefile', 'memory');
  const safe = String(scope || 'global').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(root, 'operator-instructions', safe + '.md');
}

function writeCache(scope: string, body: string): void {
  try {
    const f = cacheFile(scope);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  } catch {
    /* cache is best-effort */
  }
}

function readCache(scope: string): string {
  try {
    return readFileSync(cacheFile(scope), 'utf8');
  } catch {
    return '';
  }
}

/** Fetch the current operator instructions for a scope (default global). On a
 *  successful fetch we refresh the cache and return the live body; when the
 *  server is unreachable we serve the cached copy (offline:true). An empty/unset
 *  doc (version 0) returns body:'' so the caller can fall back to its bundled
 *  default. Never logs the body. */
export async function fetchOperatorInstructions(
  scope = 'global',
): Promise<{ scope: string; version: number; body: string; offline: boolean }> {
  const params = new URLSearchParams({ scope });
  try {
    const res = await typebuildFetch(
      `${API_BASE}/chromeext/operator-instructions?${params}`,
    );
    if (!res.ok) throw new Error(`operator-instructions fetch failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      scope?: string;
      version?: number;
      body?: string;
    };
    const body = String(data.body ?? '');
    // Only overwrite the cache when the server actually has a doc — an empty
    // server response must not wipe a good cached copy.
    if (body) writeCache(scope, body);
    return { scope: data.scope || scope, version: Number(data.version ?? 0), body, offline: false };
  } catch {
    const cached = readCache(scope);
    return { scope, version: 0, body: cached, offline: true };
  }
}
