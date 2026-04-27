#!/usr/bin/env node
// breeze-mcp — MCP server that wraps the Breeze localhost HTTP API.
//
// Why this exists: every modern coding agent (Claude Code, Codex, Gemini CLI,
// Cursor) speaks MCP natively. Rather than have each one shell out to the
// `breeze` CLI and parse text, we expose the same HTTP surface as MCP tools
// with structured args and typed JSON responses. The MCP server itself is a
// thin wrapper — same auth, same endpoints — just a different protocol envelope
// (JSON-RPC over stdio instead of HTTP+REST). The Breeze app remains the
// source of truth; this process is stateless and disposable.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API_FILE = path.join(os.homedir(), '.breezefile', 'api.json');

// ─── Connection discovery ────────────────────────────────────────────
// Read ~/.breezefile/api.json on each call. Cheap (tiny file) and means
// we don't need to restart the MCP server when the user restarts Breeze
// and the port changes.
function readApiFile() {
  try {
    const raw = readFileSync(API_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (typeof j.port !== 'number' || typeof j.token !== 'string') {
      throw new Error('api.json malformed');
    }
    return { port: j.port, token: j.token };
  } catch (e) {
    const err = new Error(
      "Breeze isn't running — open the Breeze app and try again. " +
        `(could not read ${API_FILE}: ${e.message})`,
    );
    err.code = 'BREEZE_NOT_RUNNING';
    throw err;
  }
}

function tokenOverride() {
  const t = process.env.BREEZE_API_TOKEN;
  return t && t.length > 0 ? t : null;
}

async function callBreeze(method, pathname, { query, body } = {}) {
  const { port, token } = readApiFile();
  const auth = tokenOverride() ?? token;
  const url = new URL(`http://127.0.0.1:${port}${pathname}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      Accept: 'application/json',
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(
      `Breeze HTTP request failed (${e.message}). Is the Breeze app still running?`,
    );
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text.length ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && parsed.error
        ? parsed.error
        : typeof parsed === 'string' && parsed
          ? parsed
          : res.statusText;
    throw new Error(`Breeze API ${res.status}: ${msg}`);
  }
  return parsed;
}

// ─── Helpers ─────────────────────────────────────────────────────────
function defaultTaskId(passed) {
  if (passed && typeof passed === 'string' && passed.length > 0) return passed;
  const env = process.env.BREEZE_TASK_ID;
  if (env && env.length > 0) return env;
  throw new Error(
    'task id not provided and $BREEZE_TASK_ID is not set. Pass `id` explicitly.',
  );
}

function asContent(payload) {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof payload === 'string'
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function asError(err) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

// ─── Tool catalog ────────────────────────────────────────────────────
const tools = [
  {
    name: 'task_list',
    description:
      'List Breeze tasks. Defaults to active tasks (start <= today, not done).',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'doing', 'done', 'blocked'],
          description: 'Filter by task status.',
        },
        folder: {
          type: 'string',
          description: 'Filter to tasks anchored under this folder path.',
        },
        pinned: { type: 'boolean', description: 'Filter to pinned tasks.' },
        search: {
          type: 'string',
          description: 'Substring match on title/notes.',
        },
        active_only: {
          type: 'boolean',
          description:
            'If true, only tasks with start_at <= today and status != done.',
        },
        show_completed: {
          type: 'boolean',
          description: 'Include done tasks (default true).',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = {};
      if (args.status) query.status = args.status;
      if (args.folder) query.folder = args.folder;
      if (args.pinned !== undefined) query.pinned = args.pinned ? '1' : '0';
      if (args.search) query.search = args.search;
      if (args.active_only) query.activeOnly = '1';
      if (args.show_completed === false) query.includeDone = '0';
      return callBreeze('GET', '/tasks', { query });
    },
  },
  {
    name: 'task_show',
    description:
      'Get full details of a Breeze task. Defaults to $BREEZE_TASK_ID if `id` is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = defaultTaskId(args.id);
      return callBreeze('GET', `/tasks/${encodeURIComponent(id)}`);
    },
  },
  {
    name: 'tabs_list',
    description: 'List currently-open tabs in Breeze.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => callBreeze('GET', '/app/tabs'),
  },
  {
    name: 'task_add',
    description:
      'Create a new Breeze task anchored to a folder. If `folder` is omitted and $BREEZE_TASK_ID is set, the new task inherits the parent task\'s folder.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required).' },
        folder: {
          type: 'string',
          description: 'Folder this task anchors to. Defaults to parent task folder.',
        },
        notes: { type: 'string', description: 'Free-form notes / description.' },
        start_at: {
          type: 'string',
          description: 'ISO date the task becomes active (YYYY-MM-DD).',
        },
        due_at: {
          type: 'string',
          description: 'ISO date the task is due (YYYY-MM-DD).',
        },
        ref_folder: {
          type: 'string',
          description: 'Optional second reference folder.',
        },
        pinned: { type: 'boolean', description: 'Pin to the top of the list.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (args) => {
      let folder = args.folder;
      if (!folder && process.env.BREEZE_TASK_ID) {
        try {
          const parent = await callBreeze(
            'GET',
            `/tasks/${encodeURIComponent(process.env.BREEZE_TASK_ID)}`,
          );
          if (parent && typeof parent === 'object' && parent.folder) {
            folder = parent.folder;
          }
        } catch {
          /* fall through — server will reject if folder is required */
        }
      }
      const body = {
        title: args.title,
        ...(folder ? { folder } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.start_at !== undefined ? { startAt: args.start_at } : {}),
        ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}),
        ...(args.ref_folder !== undefined ? { refFolder: args.ref_folder } : {}),
        ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
      };
      return callBreeze('POST', '/tasks', { body });
    },
  },
  {
    name: 'task_update',
    description:
      'Update fields of an existing Breeze task. Defaults to $BREEZE_TASK_ID if `id` is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        folder: { type: 'string' },
        ref_folder: { type: 'string' },
        status: {
          type: 'string',
          enum: ['todo', 'doing', 'done', 'blocked'],
        },
        start_at: { type: 'string' },
        due_at: { type: 'string' },
        pinned: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = defaultTaskId(args.id);
      const body = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.notes !== undefined) body.notes = args.notes;
      if (args.folder !== undefined) body.folder = args.folder;
      if (args.ref_folder !== undefined) body.refFolder = args.ref_folder;
      if (args.status !== undefined) body.status = args.status;
      if (args.start_at !== undefined) body.startAt = args.start_at;
      if (args.due_at !== undefined) body.dueAt = args.due_at;
      if (args.pinned !== undefined) body.pinned = args.pinned;
      return callBreeze('PATCH', `/tasks/${encodeURIComponent(id)}`, { body });
    },
  },
  {
    name: 'task_done',
    description:
      'Mark a Breeze task as done. Defaults to $BREEZE_TASK_ID if `id` is omitted.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = defaultTaskId(args.id);
      return callBreeze('PATCH', `/tasks/${encodeURIComponent(id)}`, {
        body: { status: 'done' },
      });
    },
  },
  {
    name: 'task_delete',
    description:
      'Delete a Breeze task permanently. Defaults to $BREEZE_TASK_ID if `id` is omitted.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = defaultTaskId(args.id);
      return callBreeze('DELETE', `/tasks/${encodeURIComponent(id)}`);
    },
  },
  {
    name: 'app_navigate',
    description: 'Navigate the active Breeze tab to a folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute folder path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args) =>
      callBreeze('POST', '/app/navigate', { body: { path: args.path } }),
  },
  {
    name: 'app_open_task_tab',
    description:
      'Open or focus the task tab for a given task in Breeze. Defaults to $BREEZE_TASK_ID if `task_id` is omitted.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const taskId = defaultTaskId(args.task_id);
      return callBreeze('POST', '/app/open-task-tab', { body: { taskId } });
    },
  },
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ─── Server wiring ───────────────────────────────────────────────────
const server = new Server(
  { name: 'breeze-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = toolByName.get(name);
  if (!tool) return asError(new Error(`unknown tool: ${name}`));
  try {
    const result = await tool.handler(args ?? {});
    return asContent(result ?? { ok: true });
  } catch (e) {
    return asError(e);
  }
});

// One-shot health probe at startup. Don't block startup if Breeze is down —
// MCP clients tolerate a server that's up but reports per-call errors.
async function healthProbe() {
  try {
    const { port } = readApiFile();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (!res.ok) {
      process.stderr.write(`[breeze-mcp] healthz returned ${res.status}\n`);
    }
  } catch (e) {
    process.stderr.write(
      `[breeze-mcp] startup probe: ${e.message} (will retry per-call)\n`,
    );
  }
}

await healthProbe();

const transport = new StdioServerTransport();
await server.connect(transport);
