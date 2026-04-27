#!/usr/bin/env node
// breeze — thin HTTP client for the running Breeze File app (fm-qrh).
//
// Reads ~/.breezefile/api.json (port + bearer token + pid, written by the
// app's local HTTP server) and talks to 127.0.0.1:<port>. We intentionally
// stay a pure HTTP client (not a SQLite tool) so future verbs like
// `breeze launch` reuse the same plumbing and an agent in a Claude session
// drives the live app rather than a database the app might disagree with.
//
// Pure node: builtins, no deps. Node 18+ (global fetch).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── ANSI helpers ────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const a = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: a('1'), dim: a('2'), red: a('31'), green: a('32'),
  yellow: a('33'), cyan: a('36'), gray: a('90'),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ─── Argument parser ─────────────────────────────────────────────────
// --flag value | --flag=value | --bool | positional. Boolean flags must be
// declared by the caller; otherwise --flag swallows the next token.
function parseArgs(argv, bools = new Set()) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq !== -1) { flags[t.slice(2, eq)] = t.slice(eq + 1); continue; }
      const name = t.slice(2);
      const next = argv[i + 1];
      if (bools.has(name) || next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next; i++;
      }
    } else positional.push(t);
  }
  return { positional, flags };
}

// ─── API client ──────────────────────────────────────────────────────
const API_FILE = join(homedir(), '.breezefile', 'api.json');

function loadApi() {
  if (!existsSync(API_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(API_FILE, 'utf8'));
    if (typeof j.port !== 'number' || typeof j.token !== 'string') return null;
    return j;
  } catch { return null; }
}

function pidAlive(pid) {
  if (typeof pid !== 'number') return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function notRunning(detail) {
  process.stderr.write(c.red("Breeze isn't running") + ' — open the app and try again.\n');
  if (detail) process.stderr.write(c.dim(detail) + '\n');
  process.exit(2);
}

function fail(msg) {
  process.stderr.write(c.red('error: ') + msg + '\n');
  process.exit(1);
}

async function api(method, path, body) {
  const cfg = loadApi();
  if (!cfg) notRunning(`No ${API_FILE}.`);
  if (!pidAlive(cfg.pid)) notRunning(`Stale api.json (pid ${cfg.pid} not alive).`);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(e))) {
      notRunning('Connection refused.');
    }
    fail(`request failed: ${e?.message ?? e}`);
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const msg = (parsed && parsed.error) || (typeof parsed === 'string' ? parsed : '') || `HTTP ${res.status}`;
    fail(`${method} ${path}: ${msg}`);
  }
  return parsed;
}

// ─── Output helpers ──────────────────────────────────────────────────
const STATUS_COLOR = {
  pending: c.yellow, in_progress: c.cyan, done: c.green, cancelled: c.gray,
};
const statusPill = (s) => (STATUS_COLOR[s] ?? c.dim)(s);
const shortId = (id) => (id ? id.slice(0, 8) : '');

function table(rows, columns) {
  if (rows.length === 0) return '';
  const widths = columns.map((col) => Math.max(
    col.header.length,
    ...rows.map((r) => stripAnsi(String(col.get(r) ?? '')).length),
  ));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
  const head = columns.map((col, i) => c.bold(pad(col.header, widths[i]))).join('  ');
  const sep = columns.map((_, i) => c.dim('─'.repeat(widths[i]))).join('  ');
  const body = rows.map((r) =>
    columns.map((col, i) => pad(String(col.get(r) ?? ''), widths[i])).join('  '),
  ).join('\n');
  return [head, sep, body].join('\n');
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function printTaskList(tasks) {
  if (tasks.length === 0) return process.stdout.write(c.dim('(no tasks)\n'));
  process.stdout.write(table(tasks, [
    { header: 'ID', get: (t) => c.dim(shortId(t.id)) },
    { header: 'PIN', get: (t) => (t.pinned ? c.yellow('★') : ' ') },
    { header: 'STATUS', get: (t) => statusPill(t.status) },
    { header: 'DUE', get: (t) => t.due_at ?? c.dim('-') },
    { header: 'TITLE', get: (t) => t.title },
    { header: 'FOLDER', get: (t) => c.dim(t.folder) },
  ]) + '\n');
}

function printTask(t) {
  const lines = [
    c.bold(t.title) + (t.pinned ? '  ' + c.yellow('★ pinned') : ''),
    c.dim('id     ') + t.id,
    c.dim('status ') + statusPill(t.status),
    c.dim('folder ') + t.folder,
  ];
  if (t.ref_folder) lines.push(c.dim('ref    ') + t.ref_folder);
  if (t.start_at) lines.push(c.dim('start  ') + t.start_at);
  if (t.due_at) lines.push(c.dim('due    ') + t.due_at);
  if (t.notes && t.notes.trim()) lines.push('', c.dim('notes:'), t.notes.trimEnd());
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Subcommand helpers ──────────────────────────────────────────────
// Positional <id> wins over BREEZE_TASK_ID.
const resolveId = (positional) => positional[0] ?? process.env.BREEZE_TASK_ID ?? null;
const requireId = (id) => id ?? fail('task id required (pass positional or set BREEZE_TASK_ID)');

// ─── Subcommands ─────────────────────────────────────────────────────
async function cmdStatus() {
  const cfg = loadApi();
  if (!cfg) notRunning(`No ${API_FILE}.`);
  if (!pidAlive(cfg.pid)) notRunning(`Stale api.json (pid ${cfg.pid} not alive).`);
  let h;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/healthz`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    h = await r.json();
  } catch (e) { notRunning(`healthz failed: ${e?.message ?? e}`); }
  process.stdout.write(`${c.green('ok')}  port=${cfg.port}  pid=${cfg.pid}  name=${h?.name ?? 'breeze'}\n`);
}

async function cmdTaskList(args) {
  const { flags } = parseArgs(args, new Set(['pinned', 'active', 'show-completed', 'json']));
  const qp = new URLSearchParams();
  if (flags.status) qp.set('status', flags.status);
  if (flags.folder) qp.set('folder', flags.folder);
  if (flags.pinned) qp.set('pinned', '1');
  if (flags.search) qp.set('search', flags.search);
  if (flags.active) qp.set('activeOnly', '1');
  if (!flags['show-completed'] && !flags.status) qp.set('includeDone', '0');
  const qs = qp.toString();
  const tasks = await api('GET', `/tasks${qs ? `?${qs}` : ''}`);
  flags.json ? printJson(tasks) : printTaskList(tasks);
}

async function cmdTaskShow(args) {
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const id = requireId(resolveId(positional));
  const t = await api('GET', `/tasks/${encodeURIComponent(id)}`);
  flags.json ? printJson(t) : printTask(t);
}

async function cmdTaskAdd(args) {
  const { positional, flags } = parseArgs(args, new Set(['pin', 'json']));
  const title = positional[0];
  if (!title) fail('title required: breeze task add "<title>"');
  const body = { title, folder: flags.folder ?? process.cwd() };
  if (flags['ref-folder']) body.ref_folder = flags['ref-folder'];
  if (flags.start) body.start_at = flags.start;
  if (flags.due) body.due_at = flags.due;
  if (flags.notes) body.notes = flags.notes;
  if (flags.pin) body.pinned = true;
  const t = await api('POST', '/tasks', body);
  if (flags.json) return printJson(t);
  process.stdout.write(c.green('+ ') + t.title + '  ' + c.dim(shortId(t.id)) + '\n');
}

async function cmdTaskEdit(args) {
  const { positional, flags } = parseArgs(args, new Set(['pin', 'unpin', 'json']));
  const id = requireId(resolveId(positional));
  const body = {};
  if (flags.title) body.title = flags.title;
  if (flags.folder) body.folder = flags.folder;
  if (flags['ref-folder']) body.ref_folder = flags['ref-folder'];
  if (flags.start !== undefined) body.start_at = flags.start === '' ? null : flags.start;
  if (flags.due !== undefined) body.due_at = flags.due === '' ? null : flags.due;
  if (flags.notes !== undefined) body.notes = flags.notes;
  if (flags.status) body.status = flags.status;
  if (flags.pin) body.pinned = true;
  if (flags.unpin) body.pinned = false;
  if (Object.keys(body).length === 0) fail('nothing to edit; pass at least one flag');
  const t = await api('PATCH', `/tasks/${encodeURIComponent(id)}`, body);
  if (flags.json) return printJson(t);
  process.stdout.write(c.cyan('~ ') + t.title + '  ' + c.dim(shortId(t.id)) + '\n');
}

async function cmdTaskPatch(args, patch, marker) {
  // Shared by `done`, `pin`, `unpin`.
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const id = requireId(resolveId(positional));
  const t = await api('PATCH', `/tasks/${encodeURIComponent(id)}`, patch);
  if (flags.json) return printJson(t);
  process.stdout.write(marker(t) + '\n');
}

async function cmdTaskDelete(args) {
  const { positional, flags } = parseArgs(args, new Set(['yes', 'json']));
  const id = requireId(resolveId(positional));
  if (!flags.yes) fail('refusing to delete without --yes');
  await api('DELETE', `/tasks/${encodeURIComponent(id)}`);
  if (flags.json) return printJson({ ok: true, id });
  process.stdout.write(c.red('- ') + 'deleted ' + c.dim(shortId(id)) + '\n');
}

async function cmdTaskOpen(args) {
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const id = requireId(resolveId(positional));
  await api('POST', '/app/open-task-tab', { taskId: id });
  if (flags.json) return printJson({ ok: true });
  process.stdout.write(c.green('→ ') + 'opened task tab ' + c.dim(shortId(id)) + '\n');
}

async function cmdOpen(args) {
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const folder = positional[0];
  if (!folder) fail('folder required: breeze open <folder>');
  await api('POST', '/app/navigate', { path: folder });
  if (flags.json) return printJson({ ok: true });
  process.stdout.write(c.green('→ ') + 'navigated to ' + folder + '\n');
}

async function cmdTabs(args) {
  const { flags } = parseArgs(args, new Set(['json']));
  const tabs = await api('GET', '/app/tabs');
  if (flags.json) return printJson(tabs);
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return process.stdout.write(c.dim('(no tabs)\n'));
  }
  process.stdout.write(table(tabs, [
    { header: 'ID', get: (t) => c.dim(shortId(t.id ?? '')) },
    { header: 'KIND', get: (t) => t.kind ?? '' },
    { header: 'TASK', get: (t) => (t.taskId ? c.dim(shortId(t.taskId)) : '') },
    { header: 'CWD', get: (t) => t.cwd ?? '' },
  ]) + '\n');
}

// ─── Help ────────────────────────────────────────────────────────────
const HELP = `${c.bold('breeze')} — CLI for the running Breeze File app

${c.bold('Usage:')}
  breeze status
  breeze task list   [--status=S] [--folder=PATH] [--pinned] [--search=TEXT]
                     [--active] [--show-completed] [--json]
  breeze task show   [<id>] [--json]
  breeze task add    "<title>" [--folder PATH] [--ref-folder PATH]
                     [--start YYYY-MM-DD] [--due YYYY-MM-DD]
                     [--notes TEXT] [--pin]
  breeze task edit   [<id>] [--title TEXT] [--folder PATH] [--ref-folder PATH]
                     [--start ...] [--due ...] [--notes TEXT]
                     [--status S] [--pin|--unpin]
  breeze task done   [<id>]
  breeze task pin    [<id>]
  breeze task unpin  [<id>]
  breeze task delete [<id>] --yes
  breeze task open   [<id>]
  breeze open        <folder>
  breeze tabs        [--json]
  breeze help        [<cmd>]

${c.dim('<id> defaults to $BREEZE_TASK_ID. A positional <id> always wins.')}
${c.dim('Exit codes: 0 ok, 1 error, 2 Breeze not running.')}`;

// ─── Dispatcher ──────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    return process.stdout.write(HELP + '\n');
  }
  const [head, ...rest] = argv;
  if (head === 'status') return cmdStatus();
  if (head === 'open') return cmdOpen(rest);
  if (head === 'tabs') return cmdTabs(rest);
  if (head === 'task') {
    const [sub, ...subArgs] = rest;
    switch (sub) {
      case 'list': case 'ls': return cmdTaskList(subArgs);
      case 'show': return cmdTaskShow(subArgs);
      case 'add': return cmdTaskAdd(subArgs);
      case 'edit': return cmdTaskEdit(subArgs);
      case 'done':
        return cmdTaskPatch(subArgs, { status: 'done' },
          (t) => c.green('✓ ') + t.title + '  ' + statusPill(t.status));
      case 'pin':
        return cmdTaskPatch(subArgs, { pinned: true },
          (t) => c.yellow('★ ') + t.title + '  ' + c.dim(shortId(t.id)));
      case 'unpin':
        return cmdTaskPatch(subArgs, { pinned: false },
          (t) => c.dim('☆ ') + t.title + '  ' + c.dim(shortId(t.id)));
      case 'delete': case 'rm': return cmdTaskDelete(subArgs);
      case 'open': return cmdTaskOpen(subArgs);
      default: fail(`unknown task subcommand: ${sub ?? '(none)'}. Try 'breeze help'.`);
    }
    return;
  }
  fail(`unknown command: ${head}. Try 'breeze help'.`);
}

main().catch((e) => fail(e?.message ?? String(e)));
