// Tool Repository — registry + data model.
//
// Implements the "Tool Repository Pattern" from docs/Playwright agent.md.
// Reusable, CDP-driven Playwright automations live under ~/.breezefile/tools/,
// one directory per tool:
//
//   ~/.breezefile/tools/
//     <tool-id>/
//       tool.json      ← metadata (this module's TOOL_SCHEMA)
//       tool.mjs       ← the automation; exports `async function run(ctx, params)`
//       runs.jsonl     ← append-only execution log (one JSON object per run)
//
// There is intentionally NO central registry.json file: the directory listing
// IS the registry. Discovery scans tool.json files and matches them against the
// current URL. This keeps the repository self-describing — drop a folder in and
// it's discoverable; delete it and it's gone — with no index to keep in sync.

import os from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync, existsSync, statSync, appendFileSync } from 'node:fs';

/** Root of the tool repository. Override with $BREEZE_TOOLS_DIR (tests use it). */
export function toolsDir() {
  return process.env.BREEZE_TOOLS_DIR || path.join(os.homedir(), '.breezefile', 'tools');
}

// ─── Exit codes (docs/Playwright agent.md "Status Codes & Exit Codes") ───────
// The agent maps these to decisions, so the meaning is a stable contract.
export const EXIT = {
  SUCCESS: 0,        // accomplished the goal completely
  FAILURE: 1,        // could not accomplish goal; retry unlikely to help
  VALIDATION: 2,     // ran, but output doesn't match expectations
  TIMEOUT: 3,        // external delay / network; safe to retry
  AUTH: 4,           // credentials or session invalid
  PAGE_CHANGED: 5,   // selectors/structure changed; tool needs an update
  PARTIAL: 6,        // some steps worked, others failed
  PRECONDITION: 7,   // tool requirements not satisfied (not logged in, etc.)
  INTERRUPTED: 8,    // cancelled / stopped
  USAGE: 64,         // CLI misuse (bad args) — not a tool-run outcome
};

/** Standard error categories (docs: "Error Categorization in Output"). A tool
 *  throwing a ToolError with one of these lets the runner pick the exit code
 *  and lets the agent respond appropriately. */
export const ERROR_CATEGORY = {
  selector_not_found: EXIT.PAGE_CHANGED,
  auth_failed: EXIT.AUTH,
  timeout: EXIT.TIMEOUT,
  unexpected_state: EXIT.FAILURE,
  element_disabled: EXIT.FAILURE,
  navigation_failed: EXIT.FAILURE,
  precondition_not_met: EXIT.PRECONDITION,
  rate_limited: EXIT.TIMEOUT,
  partial_success: EXIT.PARTIAL,
  validation_failed: EXIT.VALIDATION,
};

/** Error a tool can throw to signal a categorized failure. The runner reads
 *  `category` → exit code; everything else becomes structured output. */
export class ToolError extends Error {
  constructor(category, message, extra = {}) {
    super(message || category);
    this.name = 'ToolError';
    this.category = category;
    this.extra = extra;
  }
}

/** Required + optional fields of a tool.json. Used by validateTool() and as the
 *  human-facing contract documentation. */
export const TOOL_SCHEMA = {
  required: ['id', 'name', 'description', 'match'],
  optional: [
    'status',       // 'active' (default) | 'deprecated' | 'maintenance'
    'version',      // semver-ish string; default '1.0'
    'params',       // { name: { required, type, description } }
    'output',       // { field: description } — shape of result on success
    'dependencies', // free-form notes
    'known_issues', // string[]
  ],
};

/** Validate a parsed tool.json. Returns { ok, errors[] }. Conservative: only
 *  flags things that would break discovery or execution. */
export function validateTool(meta) {
  const errors = [];
  if (!meta || typeof meta !== 'object') return { ok: false, errors: ['tool.json is not an object'] };
  for (const k of TOOL_SCHEMA.required) {
    if (meta[k] === undefined || meta[k] === null || meta[k] === '') {
      errors.push(`missing required field: ${k}`);
    }
  }
  if (meta.match !== undefined) {
    const m = Array.isArray(meta.match) ? meta.match : [meta.match];
    if (!m.length) errors.push('match must list at least one URL pattern');
    for (const p of m) {
      if (typeof p !== 'string' || !p.trim()) errors.push(`match entry is not a non-empty string: ${JSON.stringify(p)}`);
    }
  }
  if (meta.status && !['active', 'deprecated', 'maintenance'].includes(meta.status)) {
    errors.push(`invalid status: ${meta.status}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Does a tool's match-pattern apply to `url`? A pattern is matched two ways
 *  (whichever hits): as a plain substring of the URL, OR — if it contains
 *  glob chars — as a `*` wildcard glob anchored to the whole URL. Domains like
 *  "availity.com" therefore match any availity URL; "*.availity.com/login*"
 *  works too. */
export function patternMatches(pattern, url) {
  if (!url) return false;
  const p = String(pattern).trim();
  if (!p) return false;
  if (/[*?]/.test(p)) {
    const rx = new RegExp(
      '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return rx.test(url);
  }
  return url.toLowerCase().includes(p.toLowerCase());
}

/** True if any of a tool's match patterns apply to `url`. */
export function toolMatchesUrl(meta, url) {
  const patterns = Array.isArray(meta.match) ? meta.match : [meta.match];
  return patterns.some((p) => patternMatches(p, url));
}

/** Read a tool's tool.json + computed paths. Returns null if the dir has no
 *  readable tool.json. */
export function loadTool(id, dir = toolsDir()) {
  const base = path.join(dir, id);
  const metaPath = path.join(base, 'tool.json');
  if (!existsSync(metaPath)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    return { id, dir: base, meta: null, error: `tool.json parse error: ${e.message}` };
  }
  // The directory name is authoritative for the id (prevents id/dir drift).
  meta.id = id;
  return {
    id,
    dir: base,
    meta,
    scriptPath: path.join(base, 'tool.mjs'),
    runsPath: path.join(base, 'runs.jsonl'),
  };
}

/** List every tool in the repository (each as from loadTool). Skips dotfiles
 *  and non-directories. Returns [] when the repo doesn't exist yet. */
export function listTools(dir = toolsDir()) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    let st;
    try { st = statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isDirectory()) continue;
    const t = loadTool(name, dir);
    if (t) out.push(t);
  }
  return out;
}

/** Tools whose match patterns apply to `url` and that aren't deprecated. */
export function toolsForUrl(url, dir = toolsDir()) {
  return listTools(dir).filter(
    (t) => t.meta && t.meta.status !== 'deprecated' && toolMatchesUrl(t.meta, url),
  );
}

/** Append a run record to a tool's runs.jsonl (one JSON object per line).
 *  Best-effort: never throws (logging must not fail a run). */
export function recordRun(runsPath, record) {
  try {
    appendFileSync(runsPath, JSON.stringify(record) + '\n');
  } catch {
    /* ignore — the log is diagnostic, not load-bearing */
  }
}

/** Summarize a tool's health from its runs.jsonl: success rate, last run,
 *  last failure. Returns nulls when there's no history. */
export function toolHealth(runsPath) {
  const empty = { runs: 0, successes: 0, success_rate: null, last_run: null, last_failure: null };
  if (!runsPath || !existsSync(runsPath)) return empty;
  let lines;
  try {
    lines = readFileSync(runsPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return empty;
  }
  let runs = 0, successes = 0, last_run = null, last_failure = null;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    runs += 1;
    if (r.status === 'success') successes += 1;
    if (r.timestamp) {
      if (!last_run || r.timestamp > last_run) last_run = r.timestamp;
      if (r.status !== 'success' && (!last_failure || r.timestamp > last_failure)) {
        last_failure = r.timestamp;
      }
    }
  }
  return {
    runs,
    successes,
    success_rate: runs ? Math.round((successes / runs) * 100) : null,
    last_run,
    last_failure,
  };
}
