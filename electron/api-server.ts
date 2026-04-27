// fm-9fd — localhost HTTP server, the external surface for the Breeze app.
//
// Binds 127.0.0.1 on an OS-chosen port at startup. Writes {port, token, pid}
// to ~/.breezefile/api.json (mode 0600) so the breeze CLI / breeze-mcp can
// find us. Bearer-token auth on every endpoint except /healthz. Cleans up
// api.json on quit. Pure node:http to avoid pulling in an Express dep.
//
// Endpoints fall into two camps:
//   - tasks/*  — pure-main work, talks directly to the tasks module.
//   - app/*    — needs the renderer (state.tabs lives there). We bridge
//                via webContents.send('control:request', …) and await a
//                reply on ipcMain.on('control:reply', …).

import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, unlinkSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import * as tasks from './tasks';
import type { TaskCreate, TaskUpdate } from './tasks';

const API_FILE_DIR = path.join(os.homedir(), '.breezefile');
const API_FILE = path.join(API_FILE_DIR, 'api.json');

let server: http.Server | null = null;
let token: string | null = null;
let pendingControl = new Map<string, (v: unknown) => void>();

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function writeApiFile(port: number) {
  if (!existsSync(API_FILE_DIR)) mkdirSync(API_FILE_DIR, { recursive: true });
  writeFileSync(
    API_FILE,
    JSON.stringify({ port, token, pid: process.pid }, null, 2),
    'utf8',
  );
  try {
    chmodSync(API_FILE, 0o600);
  } catch {
    /* non-fatal on Windows */
  }
}

function clearApiFile() {
  try {
    unlinkSync(API_FILE);
  } catch {
    /* already gone */
  }
}

// ─── Renderer bridge ──────────────────────────────────────────────────
// app/* endpoints need to read or mutate renderer-side state (tabs,
// navigation, launchers). We send a control:request to the focused
// window and wait for a control:reply. Returns the renderer's payload
// or rejects after a timeout.
type ControlKind =
  | { kind: 'navigate'; path: string }
  | { kind: 'openTaskTab'; taskId: string }
  | { kind: 'launch'; tabId: string; launcherId: string; variantId?: string }
  | { kind: 'listTabs' };

function controlRenderer<T = unknown>(req: ControlKind, timeoutMs = 4000): Promise<T> {
  const reqId = crypto.randomUUID();
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return Promise.reject(new Error('no Breeze window available'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControl.delete(reqId);
      reject(new Error(`renderer control timeout: ${req.kind}`));
    }, timeoutMs);
    pendingControl.set(reqId, (v) => {
      clearTimeout(timer);
      resolve(v as T);
    });
    win.webContents.send('control:request', { reqId, ...req });
  });
}

function registerControlReply() {
  // Single listener for the lifetime of the process.
  ipcMain.on(
    'control:reply',
    (_e, payload: { reqId: string; ok: boolean; result?: unknown; error?: string }) => {
      const cb = pendingControl.get(payload.reqId);
      if (!cb) return;
      pendingControl.delete(payload.reqId);
      if (payload.ok) cb(payload.result);
      else cb(Promise.reject(new Error(payload.error ?? 'control error')));
    },
  );
}

// ─── HTTP plumbing ───────────────────────────────────────────────────
function sendJson(res: ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function send(res: ServerResponse, status: number, msg: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const supplied = auth.slice(7).trim();
  return token !== null && timingSafeEq(supplied, token);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return crypto.timingSafeEqual(ab, bb);
}

// ─── Routing ─────────────────────────────────────────────────────────
async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const m = (req.method ?? 'GET').toUpperCase();

  // Healthz is unauthenticated so the CLI can probe before sending creds.
  if (p === '/healthz' && m === 'GET') {
    return sendJson(res, 200, { ok: true, name: 'breeze', pid: process.pid });
  }

  if (!authorized(req)) {
    return send(res, 401, 'unauthorized');
  }

  try {
    // tasks/*
    if (p === '/tasks' && m === 'GET') {
      const filter = {
        status: url.searchParams.get('status') as tasks.TaskStatus | null,
        folder: url.searchParams.get('folder') ?? undefined,
        pinned:
          url.searchParams.get('pinned') === '1'
            ? true
            : url.searchParams.get('pinned') === '0'
              ? false
              : undefined,
        search: url.searchParams.get('search') ?? undefined,
        activeOnly: url.searchParams.get('activeOnly') === '1',
        includeDone: url.searchParams.get('includeDone') !== '0',
      };
      const list = tasks.listTasks({
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.folder ? { folder: filter.folder } : {}),
        ...(filter.pinned !== undefined ? { pinned: filter.pinned } : {}),
        ...(filter.search ? { search: filter.search } : {}),
        ...(filter.activeOnly ? { activeOnly: true } : {}),
        includeDone: filter.includeDone,
      });
      return sendJson(res, 200, list);
    }
    if (p === '/tasks' && m === 'POST') {
      const body = await readJson<TaskCreate>(req);
      const t = tasks.createTask(body);
      return sendJson(res, 201, t);
    }
    const taskMatch = /^\/tasks\/([^/]+)$/.exec(p);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      if (m === 'GET') {
        const t = tasks.getTask(id);
        if (!t) return send(res, 404, 'not found');
        return sendJson(res, 200, t);
      }
      if (m === 'PATCH') {
        const body = await readJson<TaskUpdate>(req);
        const t = tasks.updateTask(id, body);
        return sendJson(res, 200, t);
      }
      if (m === 'DELETE') {
        tasks.deleteTask(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // app/*
    if (p === '/app/navigate' && m === 'POST') {
      const body = await readJson<{ path: string }>(req);
      if (!body.path) throw Object.assign(new Error('path required'), { status: 400 });
      await controlRenderer({ kind: 'navigate', path: body.path });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/app/open-task-tab' && m === 'POST') {
      const body = await readJson<{ taskId: string }>(req);
      if (!body.taskId) throw Object.assign(new Error('taskId required'), { status: 400 });
      await controlRenderer({ kind: 'openTaskTab', taskId: body.taskId });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/app/launch' && m === 'POST') {
      const body = await readJson<{
        tabId?: string;
        launcherId: string;
        variantId?: string;
      }>(req);
      if (!body.launcherId)
        throw Object.assign(new Error('launcherId required'), { status: 400 });
      await controlRenderer({
        kind: 'launch',
        tabId: body.tabId ?? '',
        launcherId: body.launcherId,
        variantId: body.variantId,
      });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/app/tabs' && m === 'GET') {
      const result = await controlRenderer<unknown>({ kind: 'listTabs' });
      return sendJson(res, 200, result);
    }

    return send(res, 404, 'not found');
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status ?? 500;
    return sendJson(res, status, { error: err.message });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────
export function startApiServer(): void {
  if (server) return;
  token = newToken();
  registerControlReply();

  server = http.createServer((req, res) => {
    void route(req, res);
  });

  server.on('error', (err) => {
    console.error('[api-server] error:', err);
  });

  // Bind to 127.0.0.1 only; OS picks the port.
  server.listen(0, '127.0.0.1', () => {
    const addr = server!.address() as AddressInfo;
    writeApiFile(addr.port);
    console.log(`[api-server] listening on 127.0.0.1:${addr.port}`);
  });

  app.on('before-quit', stopApiServer);
}

export function stopApiServer(): void {
  if (!server) return;
  clearApiFile();
  server.close();
  server = null;
  token = null;
  pendingControl.clear();
}
