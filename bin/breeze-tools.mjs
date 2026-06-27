#!/usr/bin/env node
// breeze-tools — the Tool Repository discovery + execution CLI.
//
// Implements the agent-facing CLI from docs/Playwright agent.md. An in-app
// Claude session (Bash) consults this FIRST on a browser task: try to reuse an
// existing tool; only fall back to raw DOM driving (electron/browser/cli.mjs)
// when no tool fits.
//
//   node breeze-tools.mjs available <url>        list tools that match a URL
//   node breeze-tools.mjs help <tool-id>         full metadata for one tool
//   node breeze-tools.mjs list [--json]          every tool + health
//   node breeze-tools.mjs run <tool-id> [--p v]  execute a tool over CDP
//   node breeze-tools.mjs create <id> --meta f --script f   author a new tool
//   node breeze-tools.mjs update <id> [--meta f] [--script f]
//   node breeze-tools.mjs delete <id>
//   node breeze-tools.mjs memory get|add|delete|list  --site <url>|--task <id>
//
// run() honors the OUTPUT CONTRACT (docs: "CLI Design"): structured JSON to
// stdout, a human-readable step log to stderr, and a meaningful exit code
// (0..8). Each run is appended to the tool's runs.jsonl for health tracking.
//
// Tools live in ~/.breezefile/tools/<id>/ (override: $BREEZE_TOOLS_DIR). Each
// tool.mjs exports `async function run(ctx, params)` where ctx = { page,
// browser, log, loc, EXIT, ToolError }. Returning a value (or {}) is success;
// throwing a ToolError maps its category to an exit code.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  EXIT,
  ERROR_CATEGORY,
  ToolError,
  toolsDir,
  loadTool,
  listTools,
  toolsForUrl,
  validateTool,
  recordRun,
  toolHealth,
  writeTool,
  deleteTool,
} from '../electron/browser/tools/registry.mjs';
import {
  getMemoryOnline,
  addMemoryOnline,
  deleteMemoryOnline,
  listMemory,
  memoryDir,
} from '../electron/browser/tools/memory.mjs';
// NOTE: connect.mjs is imported LAZILY inside cmdRun() only. It pulls in
// playwright-core; discovery (available/help/list) must work without a browser
// library present, since the agent runs `available <url>` first on every task.

// ─── arg parsing ─────────────────────────────────────────────────────────────
// `run <id> --user a --pass b --headed` → { _: ['run','id'], user, pass, headed:true }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ─── human step log (stderr), matching the doc's symbols ─────────────────────
function makeLog(verbose) {
  const t = () => {
    // We avoid Date.now()/new Date() being unavailable in some sandboxes by
    // guarding; a missing timestamp just drops the prefix.
    try { return new Date().toISOString().slice(11, 23); } catch { return ''; }
  };
  const w = (sym, msg) => process.stderr.write(`[${t()}] ${sym} ${msg}\n`);
  return {
    ok: (m) => w('✓', m),
    step: (m) => w('→', m),
    fail: (m) => w('✗', m),
    wait: (m) => w('⏳', m),
    debug: (m) => { if (verbose) w('·', m); },
  };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ─── available <url> ─────────────────────────────────────────────────────────
function cmdAvailable(args) {
  const url = args._[1];
  if (!url) { process.stderr.write('usage: available <url>\n'); return EXIT.USAGE; }
  const matches = toolsForUrl(url).map((t) => ({
    id: t.id,
    name: t.meta.name,
    description: t.meta.description,
    version: t.meta.version || '1.0',
    status: t.meta.status || 'active',
    params: t.meta.params || {},
    health: toolHealth(t.runsPath),
  }));
  out({ url, count: matches.length, tools: matches });
  return EXIT.SUCCESS;
}

// ─── help <tool-id> ──────────────────────────────────────────────────────────
function cmdHelp(args) {
  const id = args._[1];
  if (!id) { process.stderr.write('usage: help <tool-id>\n'); return EXIT.USAGE; }
  const t = loadTool(id);
  if (!t || !t.meta) {
    out({ error: `no such tool: ${id}`, dir: toolsDir() });
    return EXIT.FAILURE;
  }
  const v = validateTool(t.meta);
  out({ ...t.meta, _valid: v.ok, _errors: v.errors, _health: toolHealth(t.runsPath) });
  return EXIT.SUCCESS;
}

// ─── list ────────────────────────────────────────────────────────────────────
function cmdList(args) {
  const tools = listTools().map((t) => ({
    id: t.id,
    name: t.meta?.name || '(invalid)',
    status: t.meta?.status || 'active',
    version: t.meta?.version || '1.0',
    match: t.meta?.match,
    valid: t.meta ? validateTool(t.meta).ok : false,
    health: toolHealth(t.runsPath),
  }));
  if (args.json) { out({ dir: toolsDir(), count: tools.length, tools }); return EXIT.SUCCESS; }
  if (!tools.length) {
    process.stdout.write(`No tools in ${toolsDir()}\n`);
    return EXIT.SUCCESS;
  }
  for (const t of tools) {
    const rate = t.health.success_rate == null ? '—' : `${t.health.success_rate}%`;
    const flag = t.valid ? '' : '  ⚠ invalid';
    process.stdout.write(`${t.id}  v${t.version}  [${t.status}]  ${rate}  ${t.name}${flag}\n`);
  }
  return EXIT.SUCCESS;
}

// ─── run <tool-id> [--params] ────────────────────────────────────────────────
async function cmdRun(args) {
  const started = (() => { try { return Date.now(); } catch { return 0; } })();
  const nowIso = () => { try { return new Date().toISOString(); } catch { return null; } };
  const id = args._[1];
  const verbose = !!args.verbose;
  const log = makeLog(verbose);

  if (!id) { process.stderr.write('usage: run <tool-id> [--param value ...]\n'); return EXIT.USAGE; }

  const t = loadTool(id);
  if (!t || !t.meta) {
    out({ status: 'error', code: EXIT.FAILURE, error: { category: 'precondition_not_met', message: `no such tool: ${id}` } });
    return EXIT.FAILURE;
  }
  const v = validateTool(t.meta);
  if (!v.ok) {
    log.fail(`tool.json invalid: ${v.errors.join('; ')}`);
    out({ status: 'error', code: EXIT.FAILURE, error: { category: 'precondition_not_met', message: 'invalid tool.json', details: v.errors } });
    return EXIT.FAILURE;
  }

  // Collect declared params from --flags; check required ones.
  const params = {};
  const declared = t.meta.params || {};
  for (const [name, spec] of Object.entries(declared)) {
    if (args[name] !== undefined) params[name] = args[name];
    else if (spec && spec.required) {
      log.fail(`missing required param: ${name}`);
      out({ status: 'error', code: EXIT.PRECONDITION, error: { category: 'precondition_not_met', message: `missing required param: ${name}` } });
      return EXIT.PRECONDITION;
    }
  }
  // Pass through any extra --flags too (tools may accept undeclared params).
  for (const [k, val] of Object.entries(args)) {
    if (k === '_' || k === 'verbose' || k === 'headed' || k === 'json') continue;
    if (params[k] === undefined) params[k] = val;
  }

  // Load the tool module.
  let mod;
  try {
    mod = await import(pathToFileURL(t.scriptPath).href);
  } catch (e) {
    log.fail(`cannot load tool.mjs: ${e.message}`);
    out({ status: 'error', code: EXIT.FAILURE, error: { category: 'precondition_not_met', message: `tool.mjs load failed: ${e.message}` } });
    return EXIT.FAILURE;
  }
  if (typeof mod.run !== 'function') {
    out({ status: 'error', code: EXIT.FAILURE, error: { category: 'precondition_not_met', message: 'tool.mjs must export `async function run(ctx, params)`' } });
    return EXIT.FAILURE;
  }

  log.ok(`${t.meta.name} v${t.meta.version || '1.0'}`);

  // Lazy-load the CDP layer (playwright-core) — only `run` needs a browser.
  let CDP_URL, connect, openBrowserTab, resolvePage, loc;
  try {
    ({ CDP_URL, connect, openBrowserTab, resolvePage, loc } = await import(
      '../electron/browser/connect.mjs'
    ));
  } catch (e) {
    log.fail(`browser layer unavailable: ${e.message}`);
    out({ status: 'error', code: EXIT.PRECONDITION, error: { category: 'precondition_not_met', message: `playwright-core not available: ${e.message}` } });
    return EXIT.PRECONDITION;
  }

  // Connect over CDP and resolve the embedded page. If the tool declares an
  // `open` URL hint and no page exists yet, we let the tool drive `goto`;
  // resolvePage will retry while the tab attaches.
  let browser, page;
  try {
    // Some tools open their own tab first (when none exists). Optional hint:
    // tool.json `opens: true` makes the runner ensure a tab exists.
    if (t.meta.opens) await openBrowserTab(typeof t.meta.opens === 'string' ? t.meta.opens : undefined);
    browser = await connect(CDP_URL);
    page = await resolvePage(browser, { target: args.target });
  } catch (e) {
    log.fail(e.message);
    const code = /no Breeze browser window/.test(e.message) ? EXIT.PRECONDITION : EXIT.TIMEOUT;
    out({ status: 'error', code, error: { category: code === EXIT.PRECONDITION ? 'precondition_not_met' : 'timeout', message: e.message } });
    if (browser) await browser.close().catch(() => {});
    return code;
  }

  const ctx = { page, browser, log, loc, EXIT, ToolError, params, verbose };
  const finish = (status, code, payload) => {
    const duration = started ? Date.now() - started : null;
    recordRun(t.runsPath, { timestamp: nowIso(), status, code, duration_ms: duration, params: redact(params, declared) });
    out({
      status,
      code,
      tool: t.id,
      version: t.meta.version || '1.0',
      timestamp: nowIso(),
      duration_ms: duration,
      ...payload,
    });
  };

  try {
    const result = (await mod.run(ctx, params)) ?? {};
    log.ok(`SUCCESS${started ? ` (${Date.now() - started}ms)` : ''}`);
    finish('success', EXIT.SUCCESS, { result, validation: result.__validation, warnings: result.__warnings, suggestions: result.__suggestions });
    return EXIT.SUCCESS;
  } catch (e) {
    if (e instanceof ToolError) {
      const code = ERROR_CATEGORY[e.category] ?? EXIT.FAILURE;
      log.fail(`${e.category}: ${e.message}`);
      finish('failure', code, { error: { category: e.category, message: e.message, ...e.extra } });
      return code;
    }
    log.fail(e.message || String(e));
    finish('error', EXIT.FAILURE, { error: { category: 'unexpected_state', message: e.message || String(e), stack: verbose ? e.stack : undefined } });
    return EXIT.FAILURE;
  } finally {
    // Detach the CDP client only — never close Breeze or the tab.
    if (browser) await browser.close().catch(() => {});
  }
}

/** Don't write param values flagged secret in the tool's param spec to the
 *  run log (HIPAA / credential hygiene, docs: "Healthcare/Compliance"). */
function redact(params, declared) {
  const safe = {};
  for (const [k, val] of Object.entries(params)) {
    safe[k] = declared[k] && declared[k].secret ? '***' : val;
  }
  return safe;
}

// ─── create / update / delete — the "learning" half (docs Phase 5) ───────────
// Inputs come from files the agent writes: --meta <tool.json> and/or
// --script <tool.mjs>, or --from <dir> holding both. (File-based, not inline,
// so a multi-line tool.mjs survives the shell cleanly.)
function readFileArg(p) {
  if (!p || p === true) return undefined;
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    return { __err: `cannot read ${p}: ${e.message}` };
  }
}

function resolveAuthoringInputs(args) {
  let metaRaw, scriptRaw;
  if (args.from && args.from !== true) {
    metaRaw = readFileArg(path.join(args.from, 'tool.json'));
    scriptRaw = readFileArg(path.join(args.from, 'tool.mjs'));
  }
  if (args.meta !== undefined) metaRaw = readFileArg(args.meta);
  if (args.script !== undefined) scriptRaw = readFileArg(args.script);
  return { metaRaw, scriptRaw };
}

function parseMeta(metaRaw) {
  if (metaRaw === undefined) return { meta: undefined };
  if (metaRaw.__err) return { error: metaRaw.__err };
  try {
    return { meta: JSON.parse(metaRaw) };
  } catch (e) {
    return { error: `tool.json is not valid JSON: ${e.message}` };
  }
}

function cmdWrite(args, { overwrite }) {
  const verb = overwrite ? 'update' : 'create';
  const id = args._[1];
  if (!id) {
    process.stderr.write(`usage: ${verb} <tool-id> --meta <tool.json> --script <tool.mjs>  (or --from <dir>)\n`);
    return EXIT.USAGE;
  }
  const { metaRaw, scriptRaw } = resolveAuthoringInputs(args);
  const { meta, error: metaErr } = parseMeta(metaRaw);
  if (metaErr) { out({ status: 'error', error: metaErr }); return EXIT.FAILURE; }
  if (scriptRaw && scriptRaw.__err) { out({ status: 'error', error: scriptRaw.__err }); return EXIT.FAILURE; }
  // create needs both; update needs at least one.
  if (!overwrite && (meta === undefined || scriptRaw === undefined)) {
    out({ status: 'error', error: 'create needs both --meta <tool.json> and --script <tool.mjs> (or --from <dir>)' });
    return EXIT.USAGE;
  }
  if (overwrite && meta === undefined && scriptRaw === undefined) {
    out({ status: 'error', error: 'update needs --meta and/or --script (or --from <dir>)' });
    return EXIT.USAGE;
  }
  let r;
  try {
    r = writeTool(id, { meta, script: scriptRaw }, { overwrite });
  } catch (e) {
    out({ status: 'error', error: e.message });
    return EXIT.FAILURE;
  }
  if (!r.ok) { out({ status: 'error', errors: r.errors }); return EXIT.FAILURE; }
  out({ status: 'success', action: r.action, id: r.id, path: r.path });
  return EXIT.SUCCESS;
}

function cmdDelete(args) {
  const id = args._[1];
  if (!id) { process.stderr.write('usage: delete <tool-id>\n'); return EXIT.USAGE; }
  let r;
  try {
    r = deleteTool(id);
  } catch (e) {
    out({ status: 'error', error: e.message });
    return EXIT.FAILURE;
  }
  if (!r.ok) { out({ status: 'error', errors: r.errors }); return EXIT.FAILURE; }
  out({ status: 'success', action: 'deleted', id: r.removed });
  return EXIT.SUCCESS;
}

// ─── memory — durable NON-PHI notes, scoped by site or task ───────────────────
// `site` notes are SHARED ONLINE (task-3c9b1146cee2): routed through Breeze main
// to /chromeext/site-memory, with the on-disk JSON as an offline cache. `task`
// notes stay local (no fitting online store yet). The *Online helpers pick the
// path per scope, so this command is now async.
async function cmdMemory(args) {
  const sub = args._[1];
  const scope =
    args.site !== undefined ? 'site' : args.task !== undefined ? 'task' : null;
  const key = scope === 'site' ? args.site : scope === 'task' ? args.task : null;
  const needScope = () => {
    process.stderr.write('memory needs a scope: --site <url|domain> or --task <id>\n');
    return EXIT.USAGE;
  };
  try {
    switch (sub) {
      case 'list':
        // The index is the local cache (site) + local store (task); a stale
        // site cache is fine — `get --site` always recalls the live shared notes.
        out({ dir: memoryDir(), ...listMemory() });
        return EXIT.SUCCESS;
      case 'get':
        if (!scope || key === true) return needScope();
        out(await getMemoryOnline(scope, key));
        return EXIT.SUCCESS;
      case 'add': {
        if (!scope || key === true) return needScope();
        const text = args._[2];
        if (!text) {
          process.stderr.write('usage: memory add --site <url>|--task <id> "<note>"\n');
          return EXIT.USAGE;
        }
        // --kind tags a shared site note (field|flow|gotcha|selector|code|note).
        out(await addMemoryOnline(scope, key, text, { kind: args.kind }));
        return EXIT.SUCCESS;
      }
      case 'delete': {
        if (!scope || key === true) return needScope();
        // site is id-addressed (shared store): pass --id; task uses --index.
        const r = await deleteMemoryOnline(scope, key, { index: args.index, id: args.id });
        out(r);
        return r.ok ? EXIT.SUCCESS : EXIT.FAILURE;
      }
      default:
        process.stderr.write('usage: memory get|add|delete|list  --site <url>|--task <id>\n');
        return EXIT.USAGE;
    }
  } catch (e) {
    out({ status: 'error', error: e.message });
    return EXIT.FAILURE;
  }
}

function usage() {
  process.stderr.write(
    [
      'breeze-tools — reusable Playwright tool repository + memory',
      '',
      'Discover & run:',
      '  available <url>            tools matching a URL (JSON)',
      '  help <tool-id>             full metadata for one tool (JSON)',
      '  list [--json]             every tool + health',
      '  run <tool-id> [--p v ...]  execute a tool over CDP',
      '',
      'Author (learn): tool = a dir with tool.json + tool.mjs (exports run(ctx,params))',
      '  create <id> --meta <tool.json> --script <tool.mjs>   (or --from <dir>)',
      '  update <id> [--meta <f>] [--script <f>]              (or --from <dir>)',
      '  delete <id>',
      '',
      'Memory (NON-PHI notes; --site is SHARED ONLINE, --task is local):',
      '  memory get    --site <url>|--task <id>',
      '  memory add    --site <url>|--task <id> "<note>" [--kind selector|code|...]',
      '  memory delete --site <url> --id <note-id> | --task <id> [--index N]',
      '  memory list',
      '',
      `tools dir:  ${toolsDir()}`,
      `memory dir: ${memoryDir()}`,
    ].join('\n') + '\n',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'available': return cmdAvailable(args);
    case 'help': return cmdHelp(args);
    case 'list': return cmdList(args);
    case 'run': return await cmdRun(args);
    case 'create': return cmdWrite(args, { overwrite: false });
    case 'update': return cmdWrite(args, { overwrite: true });
    case 'delete': return cmdDelete(args);
    case 'memory': return await cmdMemory(args);
    case undefined:
    case 'help-cli':
      usage();
      return cmd === undefined ? EXIT.USAGE : EXIT.SUCCESS;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      usage();
      return EXIT.USAGE;
  }
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  process.stderr.write((e?.stack || e?.message || String(e)) + '\n');
  process.exit(EXIT.FAILURE);
});

// Re-exported so tests can drive arg parsing without spawning a process.
export { parseArgs };
