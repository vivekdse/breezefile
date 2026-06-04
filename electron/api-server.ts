// fm-9fd — localhost HTTP server, the external surface for the Breeze app.
//
// Binds 127.0.0.1 on an OS-chosen port at startup. Writes {port, token, pid}
// to ~/.breezefile/api.json (mode 0600) so the breeze CLI / breeze-mcp can
// find us. Bearer-token auth on every endpoint except /healthz. Cleans up
// api.json on quit. Pure node:http to avoid pulling in an Express dep.
//
// Post-P1: the PURE surface (/healthz, /tasks/*, /runs/*, /remote/resolve,
// auth, http helpers) lives in core/task-http.ts and is shared verbatim
// with the headless `breezed` daemon. This module is now just the
// Electron composer: it owns the token + server lifecycle and adds the
// renderer-coupled routes (/app/*, /claude-state).

import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, unlinkSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import { dispatchTerminalFg } from './ipc';
import { clearSessionTokens } from './session-tokens';
import { createTaskApi, sendJson, send, readJson } from './core/task-http';

const API_FILE_DIR = path.join(os.homedir(), '.breezefile');
const API_FILE = path.join(API_FILE_DIR, 'api.json');

let server: http.Server | null = null;
let token: string | null = null;
let pendingControl = new Map<string, (v: unknown) => void>();

// The shared pure task/runs/remote routes + auth. `getToken` closes over
// the mutable primary token so it's always current after startup.
const taskApi = createTaskApi(() => token);

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
  | { kind: 'open'; path: string }
  | { kind: 'openTaskTab'; taskId: string }
  | { kind: 'launch'; tabId: string; launcherId: string; variantId?: string }
  | { kind: 'listTabs' }
  // fm-awii — agent tagging API (proxied to the renderer's tag store)
  | { kind: 'tagsList' }
  | { kind: 'tagApply'; tag: string; paths: string[]; create?: boolean }
  | { kind: 'tagUntag'; tag: string; paths: string[] }
  | { kind: 'tagCreate'; name: string; color?: string }
  | { kind: 'tagsForPath'; path: string };

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

// Bring the app to the foreground after an external `breeze open`, the
// way `code <file>` raises VS Code. Best-effort; never throws.
function focusMainWindow() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch {
    /* non-fatal */
  }
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

// ─── Routing ─────────────────────────────────────────────────────────
// Order: healthz (open) → auth → shared pure routes → app/* + claude-state
// → 404. The shared routes own their own error→JSON; the app/* block has
// its own try/catch for the same envelope shape as before P1.
async function route(req: IncomingMessage, res: ServerResponse) {
  if (taskApi.tryHealthz(req, res)) return;

  if (!taskApi.authorized(req)) {
    return send(res, 401, 'unauthorized');
  }

  if (await taskApi.route(req, res)) return;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const m = (req.method ?? 'GET').toUpperCase();

  try {
    if (p === '/app/navigate' && m === 'POST') {
      const body = await readJson<{ path: string }>(req);
      if (!body.path) throw Object.assign(new Error('path required'), { status: 400 });
      await controlRenderer({ kind: 'navigate', path: body.path });
      return sendJson(res, 200, { ok: true });
    }
    // `breeze open <path>` — folders open as a (new or focused) tab,
    // markdown opens in the in-app editor, anything else falls back to
    // the OS default app. The renderer classifies the path (it owns
    // tab state + filesystem access) and returns which surface it used.
    if (p === '/app/open' && m === 'POST') {
      const body = await readJson<{ path: string }>(req);
      if (!body.path) throw Object.assign(new Error('path required'), { status: 400 });
      const result = await controlRenderer<{ kind: string }>({ kind: 'open', path: body.path });
      focusMainWindow();
      return sendJson(res, 200, { ok: true, ...(result ?? {}) });
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
    // fm-z7v — Claude Code hooks POST here to flip a tab green/red.
    // Body: {pty_id: number, state: 'busy' | 'idle'}. pty_id comes from
    // $BREEZE_PTY_ID, an env var the file_manager injects at pty spawn,
    // so this binds the event to exactly the originating tab regardless
    // of how many concurrent claude sessions are running.
    if (p === '/claude-state' && m === 'POST') {
      const body = await readJson<{ pty_id?: number | string; state?: string }>(req);
      const ptyId = Number(body.pty_id);
      const state = body.state;
      if (
        !Number.isFinite(ptyId) ||
        (state !== 'busy' && state !== 'idle' && state !== 'waiting')
      ) {
        throw Object.assign(new Error('pty_id and state required'), { status: 400 });
      }
      // 'waiting' is a mid-turn attention request — separate from 'idle'
      // so the renderer can force a banner even on the active tab.
      dispatchTerminalFg(ptyId, state as 'busy' | 'idle' | 'waiting');
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/app/tabs' && m === 'GET') {
      const result = await controlRenderer<unknown>({ kind: 'listTabs' });
      return sendJson(res, 200, result);
    }

    // fm-awii — tagging API. Tags live in the renderer store, so every route
    // proxies through the control bridge to the focused window.
    if (p === '/tags' && m === 'GET') {
      return sendJson(res, 200, await controlRenderer({ kind: 'tagsList' }));
    }
    if (p === '/tags' && m === 'POST') {
      const body = await readJson<{ name: string; color?: string }>(req);
      if (!body.name) throw Object.assign(new Error('name required'), { status: 400 });
      return sendJson(
        res,
        201,
        await controlRenderer({ kind: 'tagCreate', name: body.name, color: body.color }),
      );
    }
    if (p === '/tags/apply' && m === 'POST') {
      const body = await readJson<{ tag: string; paths: string[]; create?: boolean }>(req);
      if (!body.tag || !Array.isArray(body.paths)) {
        throw Object.assign(new Error('tag and paths required'), { status: 400 });
      }
      return sendJson(
        res,
        200,
        await controlRenderer({
          kind: 'tagApply',
          tag: body.tag,
          paths: body.paths,
          create: body.create,
        }),
      );
    }
    if (p === '/tags/untag' && m === 'POST') {
      const body = await readJson<{ tag: string; paths: string[] }>(req);
      if (!body.tag || !Array.isArray(body.paths)) {
        throw Object.assign(new Error('tag and paths required'), { status: 400 });
      }
      return sendJson(
        res,
        200,
        await controlRenderer({ kind: 'tagUntag', tag: body.tag, paths: body.paths }),
      );
    }
    if (p === '/tags/of' && m === 'GET') {
      const target = url.searchParams.get('path');
      if (!target) throw Object.assign(new Error('path required'), { status: 400 });
      return sendJson(res, 200, await controlRenderer({ kind: 'tagsForPath', path: target }));
    }

    return send(res, 404, 'not found');
  } catch (e) {
    const err = e as Error & { status?: number };
    return sendJson(res, err.status ?? 500, { error: err.message });
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
  clearSessionTokens();
  pendingControl.clear();
}
