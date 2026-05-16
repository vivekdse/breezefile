// Electron-free HTTP surface for the task store (breezed plan, P1).
//
// Owns the PURE routes (/healthz, /tasks/*, /runs/*, /remote/resolve),
// bearer auth, and the node:http helpers. Both the Electron app
// (electron/api-server.ts, which adds /app/* + /claude-state) and the
// headless `breezed` daemon compose this — neither route logic nor auth
// is duplicated. No `electron` import anywhere in this module.

import { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import * as tasks from '../tasks';
import type { TaskCreate, TaskUpdate } from '../tasks';
import { resolveRemote } from '../remoteRoute';
import { matchesSessionToken } from '../session-tokens';
import {
  AgentNotAvailableError,
  TaskAlreadyRunningError,
  executeTaskRun,
} from '../agents/execute';

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

export function send(res: ServerResponse, status: number, msg: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface TaskApi {
  /** Unauthenticated. Returns true if it answered /healthz. */
  tryHealthz(req: IncomingMessage, res: ServerResponse): boolean;
  /** Primary token OR a live session token. */
  authorized(req: IncomingMessage): boolean;
  /** Handle a pure route. Returns false if the route isn't ours (caller
   *  then tries app/* or 404). Owns its own error→JSON mapping. */
  route(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/** `getToken` returns the server's primary bearer token (or null before
 *  it's minted). Session tokens are matched via the shared module. */
export function createTaskApi(getToken: () => string | null): TaskApi {
  function authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return false;
    const supplied = auth.slice(7).trim();
    const tok = getToken();
    if (tok !== null && timingSafeEq(supplied, tok)) return true;
    return matchesSessionToken(supplied);
  }

  function tryHealthz(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' && (req.method ?? 'GET') === 'GET') {
      sendJson(res, 200, { ok: true, name: 'breeze', pid: process.pid });
      return true;
    }
    return false;
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = (req.method ?? 'GET').toUpperCase();
    try {
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
        sendJson(
          res,
          200,
          tasks.listTasks({
            ...(filter.status ? { status: filter.status } : {}),
            ...(filter.folder ? { folder: filter.folder } : {}),
            ...(filter.pinned !== undefined ? { pinned: filter.pinned } : {}),
            ...(filter.search ? { search: filter.search } : {}),
            ...(filter.activeOnly ? { activeOnly: true } : {}),
            includeDone: filter.includeDone,
          }),
        );
        return true;
      }
      if (p === '/tasks' && m === 'POST') {
        const body = await readJson<TaskCreate>(req);
        sendJson(res, 201, tasks.createTask(body));
        return true;
      }
      const taskMatch = /^\/tasks\/([^/]+)$/.exec(p);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        if (m === 'GET') {
          const t = tasks.getTask(id);
          if (!t) return (send(res, 404, 'not found'), true);
          return (sendJson(res, 200, t), true);
        }
        if (m === 'PATCH') {
          const body = await readJson<TaskUpdate>(req);
          return (sendJson(res, 200, tasks.updateTask(id, body)), true);
        }
        if (m === 'DELETE') {
          tasks.deleteTask(id);
          return (sendJson(res, 200, { ok: true }), true);
        }
      }

      const runMatch = /^\/tasks\/([^/]+)\/run$/.exec(p);
      if (runMatch && m === 'POST') {
        const id = decodeURIComponent(runMatch[1]);
        const t = tasks.getTask(id);
        if (!t) return (send(res, 404, 'not found'), true);
        const body = await readJson<{ agentId?: string }>(req);
        try {
          const { run, result } = await executeTaskRun(t, {
            agentId: body.agentId,
          });
          sendJson(res, 200, { run, result });
        } catch (e) {
          if (e instanceof AgentNotAvailableError) {
            sendJson(res, 400, { error: e.message });
          } else if (e instanceof TaskAlreadyRunningError) {
            sendJson(res, 409, {
              error: e.message,
              taskId: e.taskId,
              runId: e.runId,
            });
          } else throw e;
        }
        return true;
      }

      const runsMatch = /^\/tasks\/([^/]+)\/runs$/.exec(p);
      if (runsMatch && m === 'GET') {
        const id = decodeURIComponent(runsMatch[1]);
        const limit = Number(url.searchParams.get('limit')) || 50;
        sendJson(res, 200, tasks.listRunsForTask(id, limit));
        return true;
      }

      const oneRunMatch = /^\/runs\/([^/]+)$/.exec(p);
      if (oneRunMatch && m === 'GET') {
        const r = tasks.getRun(decodeURIComponent(oneRunMatch[1]));
        if (!r) return (send(res, 404, 'not found'), true);
        return (sendJson(res, 200, r), true);
      }

      if (p === '/remote/resolve' && m === 'GET') {
        const cwd = url.searchParams.get('cwd') ?? '';
        const r = cwd ? await resolveRemote(cwd).catch(() => null) : null;
        sendJson(res, 200, r ? { ssh: `ssh://${r.target}${r.remoteCwd}` } : {});
        return true;
      }

      return false; // not a pure route — caller handles app/* or 404
    } catch (e) {
      const err = e as Error & { status?: number };
      sendJson(res, err.status ?? 500, { error: err.message });
      return true;
    }
  }

  return { tryHealthz, authorized, route };
}
