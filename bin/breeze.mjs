#!/usr/bin/env node
// Breeze CLI — Node ESM. Talks to the running Electron app's localhost
// HTTP API (port + bearer in ~/.breezefile/api.json). Subcommands:
// prime, list, add, done, rm, install-hooks.
//
// Task shape mirrored from electron/tasks.ts. The vitest contract test
// in tests/cli.test.ts pulls live JSON and asserts shape, so drift in
// either direction surfaces in CI.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const API_FILE = join(homedir(), '.breezefile', 'api.json');
const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');

function readApi() {
  if (!existsSync(API_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(API_FILE, 'utf8'));
    if (typeof j.port !== 'number' || typeof j.token !== 'string') return null;
    return { base: `http://127.0.0.1:${j.port}`, token: j.token };
  } catch {
    return null;
  }
}

async function call(method, path, body) {
  const api = readApi();
  if (!api) return { ok: false, status: 0, body: null };
  const init = {
    method,
    headers: { Authorization: `Bearer ${api.token}` },
    signal: AbortSignal.timeout(2000),
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

// $PWD == folder OR $PWD descends from folder. Trailing slash on both
// sides prevents /foo/bar matching /foo/barbaz.
function isAncestorOrEqual(folder, pwd) {
  if (!folder) return false;
  const f = folder.replace(/\/+$/, '') + '/';
  const p = pwd.replace(/\/+$/, '') + '/';
  return p === f || p.startsWith(f);
}

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
  const pending = r.body.filter((t) => t && t.status !== 'done');
  const scoped = pending.filter((t) => isAncestorOrEqual(t.folder, pwd));

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
  const pwd = process.cwd();
  for (const t of r.body) {
    if (!t) continue;
    if (!all) {
      if (t.status === 'done') continue;
      if (!isAncestorOrEqual(t.folder, pwd)) continue;
    }
    process.stdout.write(`${t.id}  ${(t.status || '').padEnd(8)}  ${t.title}\n`);
  }
  return 0;
}

async function cmdAdd(args) {
  const title = args.shift();
  if (!title) {
    process.stderr.write('usage: breeze add <title> [--notes <text>] [--folder <path>]\n');
    return 2;
  }
  let notes = null;
  let folder = process.cwd();
  while (args.length) {
    const flag = args.shift();
    if (flag === '--notes')  notes  = args.shift();
    else if (flag === '--folder') folder = args.shift();
    else { process.stderr.write(`unknown flag: ${flag}\n`); return 2; }
  }
  const body = { title, folder };
  if (notes) body.notes = notes;
  const r = await call('POST', '/tasks', body);
  if (!r.ok || !r.body || typeof r.body.id !== 'string') {
    process.stderr.write(`create failed (HTTP ${r.status})\n`);
    return 1;
  }
  process.stdout.write(r.body.id + '\n');
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
  const command = (args.find((a) => a.startsWith('--command='))?.slice(10)) || 'breeze prime';

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

function help() {
  process.stdout.write(`breeze — CLI for the Breeze File task system.

  breeze prime                   Markdown context for Claude Code SessionStart
  breeze list [--all]            Pending tasks (or all with --all)
  breeze add <title> [--notes <text>] [--folder <path>]
                                 Create a task; folder defaults to \$PWD
  breeze done <id>               Mark task done
  breeze rm   <id>               Delete task
  breeze install-hooks [--uninstall] [--command=<cmd>]
                                 Wire SessionStart+PreCompact in ~/.claude/settings.json
                                 (idempotent; defaults command to "breeze prime")
`);
}

const [, , cmd = 'prime', ...rest] = process.argv;
const handlers = {
  prime: cmdPrime,
  list: cmdList,
  add: cmdAdd,
  done: cmdDone,
  rm: cmdRm,
  'install-hooks': cmdInstallHooks,
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
