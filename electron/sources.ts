// Multi-source task registry (breezed plan, P4). Laptop side.
//
// "local" is the in-process tasks.ts store. Each connected remote is a
// breezed daemon on another machine, reached over a forward ssh tunnel.
// No sync/merge: a task belongs to exactly one machine. The UI shows one
// section per source; mutations route to the owning source.
//
// Connected hosts (NOT tokens/ports — those are re-resolved) persist so
// the app reconnects them on next launch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import {
  ensureRemoteDaemon,
  connectRemoteDaemon,
  type RemoteConnection,
} from './remoteDaemon';

const STATE_DIR = path.join(os.homedir(), '.breezefile');
const SOURCES_FILE = path.join(STATE_DIR, 'sources.json');

type Remote = {
  host: string;
  conn: RemoteConnection;
  seq: number;
  polling: boolean;
  stopped: boolean;
};

const remotes = new Map<string, Remote>();
const connecting = new Set<string>();

function broadcast(channel: string, payload?: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function persist() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SOURCES_FILE, JSON.stringify([...remotes.keys()], null, 2));
  } catch {
    /* non-fatal */
  }
}

function loadPersisted(): string[] {
  try {
    const v = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export type SourceInfo = {
  id: string; // 'local' | host
  kind: 'local' | 'remote';
  status: 'connected' | 'connecting';
};

export function listSources(): SourceInfo[] {
  const out: SourceInfo[] = [
    { id: 'local', kind: 'local', status: 'connected' },
  ];
  for (const host of remotes.keys()) {
    out.push({ id: host, kind: 'remote', status: 'connected' });
  }
  for (const host of connecting) {
    if (!remotes.has(host)) {
      out.push({ id: host, kind: 'remote', status: 'connecting' });
    }
  }
  return out;
}

/** HTTP to a connected remote's breezed. Throws if not connected. */
export async function remoteRequest<T = unknown>(
  host: string,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const r = remotes.get(host);
  if (!r) throw new Error(`not connected: ${host}`);
  const res = await fetch(r.conn.base + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${r.conn.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(
      (parsed && parsed.error) || `HTTP ${res.status} from ${host}${apiPath}`,
    );
  }
  return parsed as T;
}

export function connectedHosts(): string[] {
  return [...remotes.keys()];
}

// Long-poll the remote's change feed; on each advance, tell the renderer
// to re-pull (same 'tasks:changed' event the local store uses).
async function pollLoop(r: Remote) {
  if (r.polling) return;
  r.polling = true;
  while (!r.stopped) {
    try {
      const out = await remoteRequest<{ seq: number }>(
        r.host,
        'GET',
        `/tasks/changes?since=${r.seq}`,
      );
      if (r.stopped) break;
      if (typeof out.seq === 'number' && out.seq !== r.seq) {
        r.seq = out.seq;
        broadcast('tasks:changed');
      }
    } catch {
      if (r.stopped) break;
      // Tunnel likely dropped — tear the source down so the UI reflects
      // reality rather than spinning forever.
      void disconnectSource(r.host);
      return;
    }
  }
  r.polling = false;
}

export async function connectSource(host: string): Promise<void> {
  if (remotes.has(host) || connecting.has(host)) return;
  connecting.add(host);
  broadcast('sources:changed');
  try {
    const ok = await ensureRemoteDaemon(host);
    if (!ok) throw new Error(`could not install/start breezed on ${host}`);
    const conn = await connectRemoteDaemon(host);
    const r: Remote = { host, conn, seq: 0, polling: false, stopped: false };
    remotes.set(host, r);
    persist();
    void pollLoop(r);
  } finally {
    connecting.delete(host);
  }
  broadcast('sources:changed');
  broadcast('tasks:changed');
}

export async function disconnectSource(host: string): Promise<void> {
  const r = remotes.get(host);
  if (!r) return;
  r.stopped = true;
  try {
    r.conn.tunnel.kill();
  } catch {
    /* already dead */
  }
  remotes.delete(host);
  persist();
  broadcast('sources:changed');
  broadcast('tasks:changed');
}

/** Best-effort reconnect of previously-connected hosts at app startup.
 *  Never blocks or throws into the caller. */
export function restoreSources(): void {
  for (const host of loadPersisted()) {
    connectSource(host).catch((e) =>
      console.warn('[sources] restore failed for', host, (e as Error).message),
    );
  }
}
