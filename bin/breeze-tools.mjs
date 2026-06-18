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
//
// run() honors the OUTPUT CONTRACT (docs: "CLI Design"): structured JSON to
// stdout, a human-readable step log to stderr, and a meaningful exit code
// (0..8). Each run is appended to the tool's runs.jsonl for health tracking.
//
// Tools live in ~/.breezefile/tools/<id>/ (override: $BREEZE_TOOLS_DIR). Each
// tool.mjs exports `async function run(ctx, params)` where ctx = { page,
// browser, log, loc, EXIT, ToolError }. Returning a value (or {}) is success;
// throwing a ToolError maps its category to an exit code.

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
} from '../electron/browser/tools/registry.mjs';
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

function usage() {
  process.stderr.write(
    [
      'breeze-tools — reusable Playwright tool repository',
      '',
      '  available <url>            tools matching a URL (JSON)',
      '  help <tool-id>             full metadata for one tool (JSON)',
      '  list [--json]             every tool + health',
      '  run <tool-id> [--p v ...]  execute a tool over CDP',
      '',
      `tools dir: ${toolsDir()}`,
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
