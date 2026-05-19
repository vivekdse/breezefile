#!/usr/bin/env node
// Breeze CLI — the single source of truth (formerly split across
// bin/breeze.mjs and cli/breeze.mjs; merged so there is one launcher,
// one shim, one set of tests). Talks to the running Electron app's
// localhost HTTP API (port + bearer in ~/.breezefile/api.json, or the
// BREEZE_API_* env in a remote-attach session).
//
// Two command surfaces, intentionally kept distinct:
//
//   • Agent/hook surface (scriptable, terse, never throws on a missing
//     app): prime, list, add, done, rm, run-now, runs, trace,
//     install-hooks. `prime` powers the Claude Code SessionStart hook
//     so it MUST stay silent + exit 0 when the app is unreachable.
//
//   • Human surface (ANSI, status pills, tabular): status, open, tabs,
//     and the `task` namespace (list/show/add/edit/done/pin/unpin/
//     delete/open). These exit 2 with a clear message when the app
//     isn't running.
//
// Task shape mirrored from electron/tasks.ts. tests/cli.contract.ts
// (compile-time) and tests/cli.test.mjs (runtime) guard both surfaces,
// so drift in either direction surfaces in CI.
//
// Pure node: builtins only, no deps. Node 18+ (global fetch,
// AbortSignal.timeout).

import {
  readFileSync, writeFileSync, copyFileSync,
  existsSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const API_FILE = join(homedir(), '.breezefile', 'api.json');
const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');

// ─── ANSI helpers ────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const a = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: a('1'), dim: a('2'), red: a('31'), green: a('32'),
  yellow: a('33'), cyan: a('36'), gray: a('90'),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ─── Argument parser (human surface) ─────────────────────────────────
// --flag value | --flag=value | --bool | positional. Boolean flags must
// be declared by the caller; otherwise --flag swallows the next token.
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

// ─── API resolution ──────────────────────────────────────────────────
function readApi() {
  // 1. Env wins: this is how a `breeze remote-attach` session reaches
  //    back to the laptop over the reverse-ssh tunnel.
  const { BREEZE_API_PORT, BREEZE_API_TOKEN, BREEZE_API_HOST } = process.env;
  if (BREEZE_API_PORT && BREEZE_API_TOKEN) {
    const host = BREEZE_API_HOST || '127.0.0.1';
    return { base: `http://${host}:${BREEZE_API_PORT}`, token: BREEZE_API_TOKEN, port: Number(BREEZE_API_PORT) };
  }
  // 2. Remote mode without env = detached session. Never fall back to a
  //    local api.json (there is none on a remote; if there were, it'd be
  //    the wrong machine's). Forces "session not attached".
  if (process.env.BREEZE_REMOTE_MODE === '1') return null;
  // 3. Local: the running app's api.json.
  if (!existsSync(API_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(API_FILE, 'utf8'));
    if (typeof j.port !== 'number' || typeof j.token !== 'string') return null;
    return { base: `http://127.0.0.1:${j.port}`, token: j.token, port: j.port, pid: j.pid };
  } catch {
    return null;
  }
}

// Graceful call for the agent/hook surface: returns {ok,status,body}
// and never throws. Callers decide whether silence (prime) or a
// non-zero exit (list/add/…) is appropriate.
async function call(method, path, body, timeoutMs = 2000) {
  const api = readApi();
  if (!api) return { ok: false, status: 0, body: null };
  const init = {
    method,
    headers: { Authorization: `Bearer ${api.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(api.base + path, init);
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { ok: r.ok, status: r.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

// Strict call for the human surface: prints a clear message and exits
// (2 = app not running, 1 = request error) instead of returning a
// sentinel. Built on the same readApi() so remote-attach env works here
// too.
function notRunning(detail) {
  process.stderr.write(c.red("Breeze isn't running") + ' — open the app and try again.\n');
  if (detail) process.stderr.write(c.dim(detail) + '\n');
  process.exit(2);
}
function fail(msg) {
  process.stderr.write(c.red('error: ') + msg + '\n');
  process.exit(1);
}
async function apiStrict(method, path, body) {
  const api = readApi();
  if (!api) notRunning(`No reachable Breeze API (no ${API_FILE} and no BREEZE_API_* env).`);
  let res;
  try {
    res = await fetch(api.base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.token}`,
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

// ─── Folder-identity matching (agent surface scoping) ────────────────
// $PWD == folder OR $PWD descends from folder. Trailing slash on both
// sides prevents /foo/bar matching /foo/barbaz.
function isAncestorOrEqual(folder, pwd) {
  if (!folder || !pwd) return false;
  const f = folder.replace(/\/+$/, '') + '/';
  const p = pwd.replace(/\/+$/, '') + '/';
  return p === f || p.startsWith(f);
}

// In a remote-attach session, anchor new tasks under the host's ssh://
// identity so they remain distinguishable from local tasks and surface
// in the matching sshfs session on the laptop.
function defaultAnchor() {
  const host = process.env.BREEZE_REMOTE_HOST;
  return host ? `ssh://${host}${process.cwd()}` : process.cwd();
}

// The folder identities the current shell should match against. On a
// remote-attach session that's the ssh:// URI. Locally it's the raw
// cwd plus — if cwd is under an sshfs mount — the ssh:// URI the app
// resolves for it, so remote-anchored tasks show up here too.
async function pwdIdentities() {
  const host = process.env.BREEZE_REMOTE_HOST;
  if (host) return [`ssh://${host}${process.cwd()}`];
  const ids = [process.cwd()];
  const r = await call('GET', `/remote/resolve?cwd=${encodeURIComponent(process.cwd())}`);
  if (r.ok && r.body && typeof r.body.ssh === 'string') ids.push(r.body.ssh);
  return ids;
}

function matchesAnyIdentity(folder, ids) {
  return ids.some((p) => isAncestorOrEqual(folder, p));
}

// ─── Agent/hook surface ──────────────────────────────────────────────
const PRIME_HEADER = `# Breeze: Active Work Context

Breeze tracks active tasks across all sessions and folders. It is the
"what am I working on right now" layer — high-level intent that may span
multiple repos, conversations, and days. Each task has an id, title,
optional notes, and a folder it's anchored to. The folder anchor is how
context flows: a task created in repo X becomes visible in any future
session launched from inside X (or any of its subdirectories).

If you were launched from a Breeze task tab, the relevant task has
already been provided to you in the conversation — use that. Otherwise,
the section below shows the active tasks anchored to this directory or
any of its ancestors. Tasks anchored to unrelated folders are hidden
and can be listed with \`breeze list --all\`.

When you create a new task with \`breeze add\`, anchor it to the most
specific folder that fits — \`--folder <path>\` (defaults to current dir).
A clean folder reference makes the task discoverable from the right
place later without you re-explaining the project context.
`;

const BEADS_SECTION = `
## When working in a beads-enabled repo
This folder has a \`.beads/\` directory, so detailed work breakdown likely
lives in beads issues. Treat breeze tasks as the strategic frame and
beads issues as the tactical units. Use \`bd ready\` to find next steps;
closing beads issues advances the breeze task. No explicit cross-link is
maintained — infer the relationship from titles, descriptions, and folder.`;

async function cmdPrime() {
  const r = await call('GET', '/tasks');
  // Silent exit when app unreachable so SessionStart hook never blocks.
  if (!r.ok || !Array.isArray(r.body)) return 0;
  const pwd = process.cwd();
  const ids = await pwdIdentities();
  const pending = r.body.filter((t) => t && t.status !== 'done');
  const scoped = pending.filter((t) => matchesAnyIdentity(t.folder, ids));

  process.stdout.write(PRIME_HEADER + '\n');
  process.stdout.write('## Active Tasks (anchored to this folder or an ancestor)\n');
  if (scoped.length === 0) {
    process.stdout.write(
      `_(none for \`${pwd}\` — list everything with \`breeze list --all\`,\n` +
      `or create one with \`breeze add "..."\` anchored here)_\n`
    );
  } else {
    for (const t of scoped) {
      process.stdout.write(`- **${t.id}** | ${t.title}\n`);
      if (t.folder) process.stdout.write(`    folder: ${t.folder}\n`);
      if (t.notes)  process.stdout.write(`    ${String(t.notes).split('\n')[0]}\n`);
    }
  }

  if (existsSync(join(pwd, '.beads'))) {
    process.stdout.write(BEADS_SECTION + '\n');
  }
  return 0;
}

async function cmdList(args) {
  const all = args.includes('--all');
  const r = await call('GET', '/tasks');
  if (!r.ok || !Array.isArray(r.body)) return 1;
  const ids = all ? null : await pwdIdentities();
  for (const t of r.body) {
    if (!t) continue;
    if (!all) {
      if (t.status === 'done') continue;
      if (!matchesAnyIdentity(t.folder, ids)) continue;
    }
    process.stdout.write(`${t.id}  ${(t.status || '').padEnd(8)}  ${t.title}\n`);
  }
  return 0;
}

async function cmdAdd(args) {
  const title = args.shift();
  if (!title) {
    process.stderr.write(
      'usage: breeze add <title> [--notes <text>] [--folder <path>]\n' +
      '                  [--auto] [--cron "<expr>"] [--agent <id>] [--prompt <text>]\n',
    );
    return 2;
  }
  let notes = null;
  let folder = defaultAnchor();
  let auto = false;
  let cron = null;
  let agent = null;
  let prompt = null;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--notes')      notes  = args.shift();
    else if (flag === '--folder') folder = args.shift();
    else if (flag === '--auto')   auto = true;
    else if (flag === '--cron')   cron = args.shift();
    else if (flag === '--agent')  agent = args.shift();
    else if (flag === '--prompt') prompt = args.shift();
    else { process.stderr.write(`unknown flag: ${flag}\n`); return 2; }
  }
  const body = { title, folder };
  if (notes)  body.notes = notes;
  if (auto)   body.auto_mode = true;
  if (cron)   body.cron = cron;
  if (agent)  body.auto_agent = agent;
  if (prompt) body.auto_prompt = prompt;
  const r = await call('POST', '/tasks', body);
  if (!r.ok || !r.body || typeof r.body.id !== 'string') {
    process.stderr.write(`create failed (HTTP ${r.status})\n`);
    return 1;
  }
  process.stdout.write(r.body.id + '\n');
  if (auto && !cron) {
    process.stdout.write('(auto-mode set; the scheduler will fire it shortly)\n');
  }
  return 0;
}

async function cmdDone(args) {
  const id = args[0];
  if (!id) { process.stderr.write('usage: breeze done <id>\n'); return 2; }
  const r = await call('PATCH', `/tasks/${encodeURIComponent(id)}`, { status: 'done' });
  if (!r.ok) { process.stderr.write(`update failed (HTTP ${r.status})\n`); return 1; }
  return 0;
}

async function cmdRm(args) {
  const id = args[0];
  if (!id) { process.stderr.write('usage: breeze rm <id>\n'); return 2; }
  const r = await call('DELETE', `/tasks/${encodeURIComponent(id)}`);
  if (!r.ok) { process.stderr.write(`delete failed (HTTP ${r.status})\n`); return 1; }
  return 0;
}

// fm-zf3m — run a task right now via its registered agent (Claude in
// v1). Synchronous from the user's POV: blocks until the agent exits.
// We give it 30 minutes; agents that take longer should be redesigned.
async function cmdRunNow(args) {
  const id = args[0];
  if (!id) { process.stderr.write('usage: breeze run-now <task-id>\n'); return 2; }
  let agentId = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agent') agentId = args[++i];
  }
  const body = agentId ? { agentId } : {};
  const r = await call('POST', `/tasks/${encodeURIComponent(id)}/run`, body, 30 * 60 * 1000);
  if (r.status === 0) {
    process.stderr.write('Breeze app not running (start it and retry)\n');
    return 1;
  }
  if (!r.ok) {
    process.stderr.write(`run failed (HTTP ${r.status}): ${JSON.stringify(r.body)}\n`);
    return 1;
  }
  const { run, result } = r.body || {};
  if (!run || !result) {
    process.stderr.write('unexpected response shape\n');
    return 1;
  }
  process.stdout.write(`run ${run.id}\n`);
  process.stdout.write(`status: ${run.status}\n`);
  if (result.conversationId) {
    process.stdout.write(`session: ${result.conversationId}\n`);
    process.stdout.write(`resume:  claude --resume ${result.conversationId}\n`);
  }
  if (run.output_path) {
    process.stdout.write(`logs:    ${run.output_path}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`error (${result.errorClass}): ${result.errorMessage}\n`);
    return 1;
  }
  return 0;
}

async function cmdRuns(args) {
  const id = args[0];
  if (!id) { process.stderr.write('usage: breeze runs <task-id>\n'); return 2; }
  const r = await call('GET', `/tasks/${encodeURIComponent(id)}/runs`);
  if (!r.ok || !Array.isArray(r.body)) {
    process.stderr.write(`fetch failed (HTTP ${r.status})\n`);
    return 1;
  }
  for (const run of r.body) {
    const when = run.started_at
      ? new Date(run.started_at).toISOString()
      : new Date(run.scheduled_for).toISOString() + ' (queued)';
    const dur = run.finished_at && run.started_at
      ? `${((run.finished_at - run.started_at) / 1000).toFixed(1)}s`
      : '—';
    process.stdout.write(
      `${run.id}  ${run.status.padEnd(10)}  attempt=${run.attempt}  ${dur.padEnd(8)}  ${when}\n`,
    );
    if (run.error_message) {
      process.stdout.write(`  error (${run.error_class}): ${run.error_message}\n`);
    }
  }
  return 0;
}

async function cmdTrace(args) {
  const id = args[0];
  if (!id) { process.stderr.write('usage: breeze trace <run-id>\n'); return 2; }
  const r = await call('GET', `/runs/${encodeURIComponent(id)}`);
  if (!r.ok || !r.body) {
    process.stderr.write(`fetch failed (HTTP ${r.status})\n`);
    return 1;
  }
  const run = r.body;
  if (run.output_path) process.stdout.write(`${run.output_path}\n`);
  if (run.conversation_id) {
    process.stdout.write(`resume: claude --resume ${run.conversation_id}\n`);
  }
  return 0;
}

// Idempotent install of SessionStart + PreCompact hooks that run
// `breeze prime`. Mirrors the philosophy of registerBreezeHooks in
// electron/hooks-register.ts: own our entries, never touch foreign
// ones. Recognised by command containing 'breeze prime'.
function isBreezePrimeHook(h) {
  return h && typeof h.command === 'string' && h.command.includes('breeze prime');
}

function stripBreezePrime(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    const kept = (b.hooks || []).filter((h) => !isBreezePrimeHook(h));
    if (kept.length > 0) out.push({ ...b, hooks: kept });
  }
  return out;
}

function cmdInstallHooks(args) {
  const remove = args.includes('--uninstall') || args.includes('-u');
  const command = (args.find((arg) => arg.startsWith('--command='))?.slice(10)) || 'breeze prime';

  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings = {};
  let originalExisted = false;
  if (existsSync(SETTINGS_FILE)) {
    originalExisted = true;
    try { settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) || {}; }
    catch (e) {
      process.stderr.write(`failed to parse ${SETTINGS_FILE}: ${e.message}\n`);
      return 1;
    }
  }

  const hooks = settings.hooks || {};
  const next = {};
  for (const k of Object.keys(hooks)) next[k] = stripBreezePrime(hooks[k]);

  if (!remove) {
    for (const event of ['SessionStart', 'PreCompact']) {
      next[event] ||= [];
      next[event].push({ matcher: '', hooks: [{ type: 'command', command }] });
    }
  }

  const before = JSON.stringify(hooks);
  const after  = JSON.stringify(next);
  if (before === after) { process.stdout.write('unchanged\n'); return 0; }

  if (originalExisted) {
    const bak = SETTINGS_FILE + '.bak';
    if (!existsSync(bak)) {
      try { copyFileSync(SETTINGS_FILE, bak); } catch { /* non-fatal */ }
    }
  }
  const out = { ...settings, hooks: next };
  writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stdout.write(remove ? 'uninstalled\n' : 'installed\n');
  return 0;
}

// ─── Human surface ───────────────────────────────────────────────────
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

// Positional <id> wins over BREEZE_TASK_ID.
const resolveId = (positional) => positional[0] ?? process.env.BREEZE_TASK_ID ?? null;
const requireId = (id) => id ?? fail('task id required (pass positional or set BREEZE_TASK_ID)');

async function cmdStatus() {
  const api = readApi();
  if (!api) notRunning(`No reachable Breeze API (no ${API_FILE} and no BREEZE_API_* env).`);
  let h;
  try {
    const r = await fetch(`${api.base}/healthz`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    h = await r.json();
  } catch (e) { notRunning(`healthz failed: ${e?.message ?? e}`); }
  process.stdout.write(
    `${c.green('ok')}  port=${api.port ?? '?'}  pid=${api.pid ?? '?'}  name=${h?.name ?? 'breeze'}\n`,
  );
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
  const tasks = await apiStrict('GET', `/tasks${qs ? `?${qs}` : ''}`);
  flags.json ? printJson(tasks) : printTaskList(tasks);
}

async function cmdTaskShow(args) {
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const id = requireId(resolveId(positional));
  const t = await apiStrict('GET', `/tasks/${encodeURIComponent(id)}`);
  flags.json ? printJson(t) : printTask(t);
}

async function cmdTaskAdd(args) {
  const { positional, flags } = parseArgs(args, new Set(['pin', 'auto', 'json']));
  const title = positional[0];
  if (!title) fail('title required: breeze task add "<title>"');
  const body = { title, folder: flags.folder ?? defaultAnchor() };
  if (flags['ref-folder']) body.ref_folder = flags['ref-folder'];
  if (flags.start) body.start_at = flags.start;
  if (flags.due) body.due_at = flags.due;
  if (flags.notes) body.notes = flags.notes;
  if (flags.pin) body.pinned = true;
  if (flags.auto) body.auto_mode = true;
  if (flags.cron) body.cron = flags.cron;
  if (flags.agent) body.auto_agent = flags.agent;
  if (flags.prompt) body.auto_prompt = flags.prompt;
  const t = await apiStrict('POST', '/tasks', body);
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
  const t = await apiStrict('PATCH', `/tasks/${encodeURIComponent(id)}`, body);
  if (flags.json) return printJson(t);
  process.stdout.write(c.cyan('~ ') + t.title + '  ' + c.dim(shortId(t.id)) + '\n');
}

async function cmdTaskPatch(args, patch, marker) {
  // Shared by `task done`, `task pin`, `task unpin`.
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const id = requireId(resolveId(positional));
  const t = await apiStrict('PATCH', `/tasks/${encodeURIComponent(id)}`, patch);
  if (flags.json) return printJson(t);
  process.stdout.write(marker(t) + '\n');
}

async function cmdTaskDelete(args) {
  const { positional, flags } = parseArgs(args, new Set(['yes', 'json']));
  const id = requireId(resolveId(positional));
  if (!flags.yes) fail('refusing to delete without --yes');
  await apiStrict('DELETE', `/tasks/${encodeURIComponent(id)}`);
  if (flags.json) return printJson({ ok: true, id });
  process.stdout.write(c.red('- ') + 'deleted ' + c.dim(shortId(id)) + '\n');
}

async function cmdTaskOpen(args) {
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const id = requireId(resolveId(positional));
  await apiStrict('POST', '/app/open-task-tab', { taskId: id });
  if (flags.json) return printJson({ ok: true });
  process.stdout.write(c.green('→ ') + 'opened task tab ' + c.dim(shortId(id)) + '\n');
}

async function cmdOpen(args) {
  const { positional, flags } = parseArgs(args, new Set(['json']));
  const folder = positional[0];
  if (!folder) fail('folder required: breeze open <folder>');
  await apiStrict('POST', '/app/navigate', { path: folder });
  if (flags.json) return printJson({ ok: true });
  process.stdout.write(c.green('→ ') + 'navigated to ' + folder + '\n');
}

async function cmdTabs(args) {
  const { flags } = parseArgs(args, new Set(['json']));
  const tabs = await apiStrict('GET', '/app/tabs');
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

async function cmdTask(args) {
  const [sub, ...subArgs] = args;
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
    default:
      process.stderr.write(`unknown task subcommand: ${sub ?? '(none)'}. Try 'breeze help'.\n`);
      return 2;
  }
}

// ─── Help ────────────────────────────────────────────────────────────
// Kept plain (no ANSI) so it stays greppable and pipe-friendly.
function help() {
  process.stdout.write(`breeze — CLI for the running Breeze File app.

Agent / scripting surface (terse, exits 0 silently if app is down):
  breeze prime                   Markdown context for Claude Code SessionStart
  breeze list [--all]            Pending tasks (or all with --all)
  breeze add <title> [--notes <text>] [--folder <path>]
             [--auto] [--cron "<expr>"] [--agent <id>] [--prompt <text>]
                                 Create a task; folder defaults to \$PWD.
                                 --auto fires the task once on creation;
                                 add --cron to recur on a 5-field schedule.
  breeze done <id>               Mark task done
  breeze rm   <id>               Delete task
  breeze run-now <task-id> [--agent <id>]
                                 Execute the task immediately via an agent
  breeze runs <task-id>          List recent run attempts for a task
  breeze trace <run-id>          Print log path + claude resume command
  breeze install-hooks [--uninstall] [--command=<cmd>]
                                 Wire SessionStart+PreCompact in ~/.claude/settings.json
                                 (idempotent; defaults command to "breeze prime")

Human surface (ANSI tables; exits 2 if the app isn't running):
  breeze status
  breeze open  <folder>
  breeze tabs  [--json]
  breeze task list   [--status=S] [--folder=PATH] [--pinned] [--search=TEXT]
                     [--active] [--show-completed] [--json]
  breeze task show   [<id>] [--json]
  breeze task add    "<title>" [--folder PATH] [--ref-folder PATH]
                     [--start YYYY-MM-DD] [--due YYYY-MM-DD]
                     [--notes TEXT] [--pin] [--auto] [--cron "<expr>"]
                     [--agent <id>] [--prompt TEXT]
  breeze task edit   [<id>] [--title TEXT] [--folder PATH] [--ref-folder PATH]
                     [--start ...] [--due ...] [--notes TEXT]
                     [--status S] [--pin|--unpin]
  breeze task done   [<id>]
  breeze task pin    [<id>]
  breeze task unpin  [<id>]
  breeze task delete [<id>] --yes
  breeze task open   [<id>]

<id> defaults to \$BREEZE_TASK_ID. A positional <id> always wins.
Exit codes: 0 ok, 1 error, 2 Breeze not running.
`);
  return 0;
}

// ─── Dispatcher ──────────────────────────────────────────────────────
const [, , cmd = 'prime', ...rest] = process.argv;
const handlers = {
  // agent / scripting
  prime: cmdPrime,
  list: cmdList,
  add: cmdAdd,
  done: cmdDone,
  rm: cmdRm,
  'run-now': cmdRunNow,
  runs: cmdRuns,
  trace: cmdTrace,
  'install-hooks': cmdInstallHooks,
  // human
  status: cmdStatus,
  open: cmdOpen,
  tabs: cmdTabs,
  task: cmdTask,
  // help
  help, '-h': help, '--help': help,
};
const fn = handlers[cmd];
if (!fn) {
  process.stderr.write(`unknown subcommand: ${cmd}\n`);
  process.exit(2);
}
const r = fn(rest);
if (r && typeof r.then === 'function') {
  r.then((code) => process.exit(code ?? 0)).catch((e) => {
    process.stderr.write(`${e.stack || e.message}\n`);
    process.exit(1);
  });
} else {
  process.exit(r ?? 0);
}
