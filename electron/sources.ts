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

// breezed holds /tasks/changes open up to 25s when idle. The client
// timeout MUST exceed that, or every idle poll "times out" and looks
// like a dead tunnel (that bug nuked the connection ~15s after connect).
const CHANGE_POLL_TIMEOUT_MS = 35_000;

// Long-poll the remote's change feed; on each advance, tell the renderer
// to re-pull (same 'tasks:changed' event the local store uses). An
// idle-timeout/abort is NORMAL — just re-poll. Only a run of genuine
// failures (tunnel actually dropped) tears the source down.
async function pollLoop(r: Remote) {
  if (r.polling) return;
  r.polling = true;
  let consecutiveFailures = 0;
  while (!r.stopped) {
    try {
      const res = await fetch(`${r.conn.base}/tasks/changes?since=${r.seq}`, {
        headers: { Authorization: `Bearer ${r.conn.token}` },
        signal: AbortSignal.timeout(CHANGE_POLL_TIMEOUT_MS),
      });
      if (r.stopped) break;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = (await res.json()) as { seq?: number };
      consecutiveFailures = 0;
      if (typeof out.seq === 'number' && out.seq !== r.seq) {
        r.seq = out.seq;
        broadcast('tasks:changed');
      }
    } catch (e) {
      if (r.stopped) break;
      // Our own idle-timeout: the long-poll simply found no change in
      // 35s. Not an error — immediately re-poll.
      if (e instanceof Error && e.name === 'TimeoutError') continue;
      // A real failure (ECONNREFUSED, tunnel exited, auth). Tolerate a
      // couple of transient blips before tearing down.
      if (++consecutiveFailures < 3) {
        await new Promise((res2) => setTimeout(res2, 1500));
        continue;
      }
      // Tunnel really gone — tear the source down so the UI reflects
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
