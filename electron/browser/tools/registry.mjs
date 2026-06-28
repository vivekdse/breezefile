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
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';

/** Root of the tool repository. Override with $BREEZE_TOOLS_DIR (tests use it). */
export function toolsDir() {
  return process.env.BREEZE_TOOLS_DIR || path.join(os.homedir(), '.breezefile', 'tools');
}

/** A tool id is also its directory name, so it must be a safe path segment.
 *  Throws on anything that could traverse or collide. */
const TOOL_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
export function safeToolId(id) {
  if (typeof id !== 'string' || !TOOL_ID_RE.test(id)) {
    throw new Error(
      `invalid tool id ${JSON.stringify(id)} — use letters, digits, '-' and '_' (no slashes, must start alphanumeric)`,
    );
  }
  return id;
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
    'steps',        // [{ name, sideEffect }] — DECLARED step contract (mirrors
                    //   the tool.mjs `steps` export so `help`/discovery can show
                    //   the ordered, named, side-effect-marked plan without
                    //   importing the module). Optional + advisory: the module's
                    //   exported `steps` is authoritative at run time. See
                    //   docs/resumable-tool-steps.md.
  ],
};

// ─── Resumable steps (Operator Speed) ────────────────────────────────────────
// A tool.mjs may export `const steps = [{ name, sideEffect, run, pre?, post? }]`
// INSTEAD of (or alongside) a single `run`. The runner executes the steps in
// order, records which ones completed in runs.jsonl, and can RESUME from a named
// step after a partial break — without re-firing a side-effect that already
// happened. The functions below are the PURE planning core (no browser), so the
// safety invariant is unit-testable. See docs/resumable-tool-steps.md.

const STEP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** Normalize a tool module's exported `steps` (or a lone `run`) into a canonical
 *  ordered list of { name, sideEffect, run, pre, post }.
 *  Back-compat: a module with only `run` (no `steps`) becomes ONE implicit step
 *  named 'run'. That implicit step is marked sideEffect:true and resumable:false
 *  — a legacy opaque `run` may submit a form, so we must never auto-replay it.
 *  Returns { ok, steps, errors, implicit }. */
export function normalizeSteps(mod) {
  const errors = [];
  const hasSteps = Array.isArray(mod?.steps) && mod.steps.length > 0;
  if (!hasSteps) {
    if (typeof mod?.run !== 'function') {
      return { ok: false, steps: [], errors: ['tool.mjs must export `run` or a non-empty `steps` array'], implicit: false };
    }
    // Implicit single step. sideEffect:true is the SAFE default: an opaque legacy
    // run is assumed to have an irreversible effect, so resume never replays it.
    return {
      ok: true,
      implicit: true,
      steps: [{ name: 'run', sideEffect: true, run: mod.run, pre: undefined, post: undefined }],
      errors,
    };
  }
  const seen = new Set();
  const steps = [];
  mod.steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${where} is not an object`); return; }
    const name = s.name;
    if (typeof name !== 'string' || !STEP_NAME_RE.test(name)) {
      errors.push(`${where}.name must match ${STEP_NAME_RE} (got ${JSON.stringify(name)})`);
    } else if (seen.has(name)) {
      errors.push(`${where}.name duplicates an earlier step: ${name}`);
    } else {
      seen.add(name);
    }
    if (typeof s.run !== 'function') errors.push(`${where}.run must be a function`);
    if (s.sideEffect !== undefined && typeof s.sideEffect !== 'boolean') {
      errors.push(`${where}.sideEffect must be a boolean`);
    }
    if (s.pre !== undefined && typeof s.pre !== 'function') errors.push(`${where}.pre must be a function`);
    if (s.post !== undefined && typeof s.post !== 'function') errors.push(`${where}.post must be a function`);
    steps.push({
      name,
      sideEffect: s.sideEffect === true,
      run: s.run,
      pre: typeof s.pre === 'function' ? s.pre : undefined,
      post: typeof s.post === 'function' ? s.post : undefined,
    });
  });
  return { ok: errors.length === 0, steps, errors, implicit: false };
}

/** Plan execution given the normalized steps and a desired resume point.
 *
 *  THE SIDE-EFFECT SAFETY INVARIANT (load-bearing):
 *  Resume must START AT OR AFTER the broken step. Steps strictly BEFORE the
 *  resume cursor are SKIPPED (treated as already done) and are never re-run, so
 *  a side-effecting step that already completed can never re-fire. We further
 *  REFUSE a resume that would land the cursor *before* a step recorded as a
 *  completed side-effect: that would mean re-running it, which is forbidden.
 *
 *  @param steps         normalized steps (from normalizeSteps)
 *  @param resumeFrom    step name to resume at, or null/undefined for a clean run
 *  @param doneNames     names of steps already completed in a prior run (from the
 *                       runs.jsonl cursor); used to (a) auto-pick a resume point
 *                       and (b) guard against replaying a done side-effect.
 *  @returns { ok, startIndex, skip:[names], plan:[names], errors:[] }
 */
export function planResume(steps, resumeFrom, doneNames = []) {
  const errors = [];
  const names = steps.map((s) => s.name);
  const done = new Set(doneNames);

  let startIndex = 0;
  if (resumeFrom !== undefined && resumeFrom !== null && resumeFrom !== '') {
    startIndex = names.indexOf(resumeFrom);
    if (startIndex === -1) {
      return { ok: false, startIndex: 0, skip: [], plan: [], errors: [`no such step to resume from: ${resumeFrom} (steps: ${names.join(', ') || 'none'})`] };
    }
    // An implicit (legacy) single step is non-resumable: refuse to "resume" it,
    // because a clean run of it might re-fire its side effect.
    if (names.length === 1 && steps[0].sideEffect && steps[0].name === 'run') {
      // Allow resume-from only when it IS that step AND it wasn't already done.
      // (Still safe: starting AT the step is a first run, not a replay.)
    }
  } else if (doneNames.length) {
    // Auto-resume: start at the first step NOT recorded done.
    const firstUndone = steps.findIndex((s) => !done.has(s.name));
    startIndex = firstUndone === -1 ? steps.length : firstUndone;
  }

  // GUARD: every step BEFORE the cursor is skipped. If any skipped step is a
  // side-effect that was NOT yet recorded done, skipping it is a correctness
  // bug (we'd assume an effect happened that didn't). If a step AT/AFTER the
  // cursor is a side-effect ALREADY recorded done, running it would REPLAY it.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i < startIndex) {
      // skipped — must already be done
      if (s.sideEffect && !done.has(s.name)) {
        errors.push(`refusing to skip side-effecting step "${s.name}" that is not recorded as completed (resume would assume an effect that never fired)`);
      }
    } else {
      // will run — a side-effect that already fired must NOT be re-run
      if (s.sideEffect && done.has(s.name)) {
        errors.push(`refusing to re-run completed side-effecting step "${s.name}" (resume must start strictly after it)`);
      }
    }
  }

  const skip = names.slice(0, startIndex);
  const plan = names.slice(startIndex);
  return { ok: errors.length === 0, startIndex, skip, plan, errors };
}

/** Read the cursor (completed step names + last failed step) from the most
 *  recent run record in runs.jsonl. Returns { steps_done:[], failed_step:null,
 *  status:null } when there's no usable history. NON-PHI: only step names. */
export function lastCursor(runsPath) {
  const empty = { steps_done: [], failed_step: null, status: null, timestamp: null };
  if (!runsPath || !existsSync(runsPath)) return empty;
  let lines;
  try { lines = readFileSync(runsPath, 'utf8').split('\n').filter(Boolean); }
  catch { return empty; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (Array.isArray(r.steps_done) || r.failed_step) {
      return {
        steps_done: Array.isArray(r.steps_done) ? r.steps_done : [],
        failed_step: r.failed_step ?? null,
        status: r.status ?? null,
        timestamp: r.timestamp ?? null,
      };
    }
  }
  return empty;
}

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

// ─── Tool authoring (create / update / delete) — the "learning" half ─────────
// docs/Playwright agent.md Phase 5 (Tool Creation & Packaging): turn a solved
// task into a reusable tool. These WRITE the repository; discovery above only
// reads it.

/** Create or update a tool on disk: ~/.breezefile/tools/<id>/{tool.json,tool.mjs}.
 *  - create (overwrite=false): fails if the tool already exists.
 *  - update (overwrite=true):  fails if it does NOT exist; `meta`/`script` are
 *    each optional — an omitted one keeps the existing file.
 *  `meta` is validated against TOOL_SCHEMA (id is forced to the dir name). The
 *  script must be a non-empty string exporting `run(ctx, params)` (we don't
 *  import it here — `run` validates at execution). Returns { ok, errors, path,
 *  id, action }. Never throws on validation; throws only on a bad id. */
export function writeTool(id, { meta, script } = {}, { dir = toolsDir(), overwrite = false } = {}) {
  safeToolId(id);
  const base = path.join(dir, id);
  const exists = existsSync(path.join(base, 'tool.json'));
  if (exists && !overwrite) {
    return { ok: false, errors: [`tool '${id}' already exists — use update`], path: base };
  }
  if (!exists && overwrite) {
    return { ok: false, errors: [`tool '${id}' does not exist — use create`], path: base };
  }

  // For an update, fall back to the existing meta/script when one isn't given.
  let finalMeta = meta;
  let finalScript = script;
  if (exists && overwrite) {
    const cur = loadTool(id, dir);
    if (finalMeta === undefined) finalMeta = cur?.meta ?? {};
    if (finalScript === undefined) {
      try { finalScript = readFileSync(cur.scriptPath, 'utf8'); } catch { finalScript = undefined; }
    }
  }

  finalMeta = { ...(finalMeta || {}), id }; // dir name is authoritative for id
  const v = validateTool(finalMeta);
  if (!v.ok) return { ok: false, errors: v.errors, path: base };
  if (typeof finalScript !== 'string' || !finalScript.trim()) {
    return { ok: false, errors: ['tool.mjs script is required (non-empty string)'], path: base };
  }

  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, 'tool.json'), JSON.stringify(finalMeta, null, 2) + '\n');
  writeFileSync(
    path.join(base, 'tool.mjs'),
    finalScript.endsWith('\n') ? finalScript : finalScript + '\n',
  );
  return { ok: true, errors: [], path: base, id, action: exists ? 'updated' : 'created' };
}

/** Delete a tool directory (and its run history). Returns { ok, removed } or
 *  { ok:false, errors }. Throws only on a bad id. */
export function deleteTool(id, dir = toolsDir()) {
  safeToolId(id);
  const base = path.join(dir, id);
  if (!existsSync(base)) return { ok: false, errors: [`no such tool: ${id}`] };
  rmSync(base, { recursive: true, force: true });
  return { ok: true, removed: id };
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
