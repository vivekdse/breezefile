// Auto-promotion — turn a full-agent (raw-driver) solve into a reusable tool.
//
// Closes the novel→fast loop so a novel page is paid for ONCE. After the slow
// tier-4 full-agent path solves something reusable, the agent CAPTURES the
// successful raw-driver verb sequence (and/or the recorded flow from
// electron/browser/record.ts) and this module SCAFFOLDS a step-structured
// `tool.mjs` + `tool.json` — written via the existing `breeze-tools create`
// (writeTool). The emitted tool is marked `status: candidate` until it proves
// itself over a run or two (toolHealth), then graduates to `active`.
//
// Result: "support a new platform" = "run it once with the agent, keep the tool
// it leaves behind." The next run on that URL lands at tier 2 (deterministic
// tool), not tier 4 (slow agent).
//
// This module is PURE (no browser, no app) so the scaffold ↔ step-shape mapping
// is unit-testable. The runner (bin/breeze-tools.mjs) calls scaffoldTool() then
// writeTool(); promotion thresholds read runs.jsonl health.
//
// ─── PHI / NON-PHI invariant (load-bearing) ──────────────────────────────────
// The emitted tool is a SHARED, NON-PHI CODE ARTIFACT — it syncs through the
// SAME channel site/task memory uses and reaches every runner. So a captured
// step may reference a `data`/`me.*` placeholder KEY (e.g. "patient.ssn",
// "me.npi") but NEVER a resolved value. A fill that carried a literal value in
// the raw run is emitted as a `fill-ref`-style step keyed by a PARAM (the param
// value is supplied at run time via the vault), never inlined. scaffoldTool()
// REJECTS any captured action whose value looks like a resolved secret rather
// than a placeholder key / param ref (assertNoLiteralValue).

import { isMutatingMethod } from '../net.mjs';

/** A step name must match the registry's STEP_NAME_RE. We derive names from the
 *  action verb + index; this sanitizer keeps them legal + unique. */
function stepName(base, i) {
  const slug = String(base || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'step';
  return `${slug}-${i + 1}`;
}

/** Heuristic: does a string look like a RESOLVED secret value rather than a
 *  NON-PHI placeholder key or a param ref? Placeholder keys are dotted lowercase
 *  identifiers (patient.ssn, me.npi); param refs are {{param}} or :param. Anything
 *  else that's a value-shaped literal (digits, spaces, @, long mixed strings) is
 *  treated as a leaked value and rejected. */
const PLACEHOLDER_KEY_RE = /^(me|data|patient|entity|customer)\.[a-z0-9_.]+$/i;
const PARAM_REF_RE = /^(\{\{\s*[a-z0-9_]+\s*\}\}|:[a-z0-9_]+|\$[a-z0-9_]+)$/i;

export function looksLikeLiteralValue(s) {
  if (typeof s !== 'string' || s === '') return false;
  if (PLACEHOLDER_KEY_RE.test(s)) return false; // a placeholder KEY — fine
  if (PARAM_REF_RE.test(s)) return false;        // a param ref — fine
  return true;                                   // anything else is a literal
}

/** Throw if a value-bearing action carries a literal value (PHI leak guard). */
function assertNoLiteralValue(action) {
  // A `fill`/`type` with a `ref` (placeholder key / param) is fine; a `value`
  // that is a literal is NOT — it would bake PHI/creds into the shared artifact.
  if (action.value !== undefined && looksLikeLiteralValue(action.value)) {
    throw new Error(
      `refusing to scaffold: action "${action.verb}" carries a literal value ` +
        `("${String(action.value).slice(0, 8)}…") — captured fills must use a ` +
        'placeholder KEY (e.g. patient.ssn) or a param ref ({{param}}), never a value.',
    );
  }
}

/** Map one captured raw-driver action to a fragment of emitted step body + the
 *  param names / refs it introduces. The captured vocab mirrors cli.mjs verbs:
 *    { verb:'goto', url }
 *    { verb:'click', selector }
 *    { verb:'fill'|'type', selector, ref }     ref = placeholder KEY or {{param}}
 *    { verb:'press', key }
 *    { verb:'wait', selector }
 *    { verb:'net-replay', method, url, dataRef? }   the API shortcut, captured
 *  Returns { code:string[], params:{name:spec}, sideEffect:boolean }. */
function emitAction(action) {
  assertNoLiteralValue(action);
  const params = {};
  const code = [];
  const refToParam = (ref) => {
    // {{param}} → params.param ; a placeholder KEY stays a literal ref string.
    const m = /^\{\{\s*([a-z0-9_]+)\s*\}\}$/i.exec(ref || '');
    if (m) {
      const p = m[1];
      params[p] = { required: true, type: 'string', description: `value for ${p}` };
      return { kind: 'param', name: p };
    }
    return { kind: 'key', key: ref };
  };

  switch (action.verb) {
    case 'goto':
      code.push(`  await page.goto(${JSON.stringify(action.url)}, { waitUntil: 'domcontentloaded' });`);
      return { code, params, sideEffect: false };
    case 'click':
      // A click can be a navigation OR a submit; the capturer marks submit clicks
      // sideEffect:true. Default to NON-side-effect (most clicks are navigation).
      code.push(`  await loc(page, ${JSON.stringify(action.selector)}).click();`);
      return { code, params, sideEffect: action.sideEffect === true };
    case 'fill':
    case 'type': {
      const r = refToParam(action.ref);
      const method = action.verb === 'fill' ? 'fill' : 'pressSequentially';
      if (r.kind === 'param') {
        code.push(`  await loc(page, ${JSON.stringify(action.selector)}).${method}(params.${r.name});`);
      } else {
        // A placeholder KEY: the runner resolves it via the vault at run time.
        // We emit a fillRef call (ctx.fillRef) so the value never enters code.
        code.push(`  await ctx.fillRef(${JSON.stringify(action.selector)}, ${JSON.stringify(r.key)});`);
      }
      return { code, params, sideEffect: false };
    }
    case 'press':
      // Enter on a form is often the submit — capturer may mark it side-effecting.
      code.push(`  await page.keyboard.press(${JSON.stringify(action.key)});`);
      return { code, params, sideEffect: action.sideEffect === true };
    case 'wait':
      code.push(`  await loc(page, ${JSON.stringify(action.selector)}).waitFor();`);
      return { code, params, sideEffect: false };
    case 'net-replay': {
      // THE API SHORTCUT, captured as the tool's fast path. A mutating replay is
      // a side effect (human-gated); a GET is a safe read.
      const mutating = isMutatingMethod(action.method);
      const replaySpec = `{ method: ${JSON.stringify(action.method || 'GET')}, url: ${JSON.stringify(action.url)} }`;
      const opts = mutating ? `{ allowMutation: true }` : `{}`;
      code.push(`  const __res = await ctx.replay(${replaySpec}, ${opts});`);
      code.push(`  state.lastResponse = { status: __res.status, ok: __res.ok };`);
      return { code, params, sideEffect: mutating };
    }
    default:
      throw new Error(`cannot scaffold unknown captured verb: ${JSON.stringify(action.verb)}`);
  }
}

// Verbs that do no operative DOM work — pure scaffolding around an API call. If
// the ONLY non-`net-replay` actions in a solve are these, the solve was really an
// intercepted API call and the tool belongs on the `http` channel.
const INERT_VERBS = new Set(['goto', 'wait']);

/** Decide a tool's `channel` label from its captured actions. Returns 'http' when
 *  the OPERATIVE work was the intercepted API request(s): there is at least one
 *  `net-replay` action AND every other action is inert scaffolding (goto/wait).
 *  Any real DOM verb (click/fill/type/press) means the browser did the work →
 *  'browser'. A solve with no net-replay is always 'browser'. Pure + NON-PHI: it
 *  reads only action verbs, never values. */
export function channelForActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const hasReplay = list.some((a) => a && a.verb === 'net-replay');
  if (!hasReplay) return 'browser';
  const allApiOrInert = list.every(
    (a) => a && (a.verb === 'net-replay' || INERT_VERBS.has(a.verb)),
  );
  return allApiOrInert ? 'http' : 'browser';
}

/** Convert a recorded flow (electron/browser/record.ts RecordedAction[]) into the
 *  captured-action vocab emitAction understands. A recorded `input` carries a
 *  placeholder KEY (record.ts persists KEYS, never values), so it maps to a
 *  fill-by-key; a `navigate` → goto; a `click` → click. */
export function actionsFromRecording(recorded) {
  const out = [];
  for (const a of recorded || []) {
    const selector = a.best ? a.best.selector : a.selector;
    switch (a.action) {
      case 'navigate':
        out.push({ verb: 'goto', url: a.to || a.url });
        break;
      case 'click':
        out.push({ verb: 'click', selector });
        break;
      case 'input':
      case 'change':
        // record.ts stores a placeholder KEY in `placeholder` — NEVER a value.
        out.push({ verb: 'fill', selector, ref: a.placeholder || `{{field_${out.length + 1}}}` });
        break;
      default:
        /* skip anything we don't model */
        break;
    }
  }
  return out;
}

/**
 * Scaffold a step-structured candidate tool from a captured raw-driver sequence.
 *
 * @param spec.id          tool id (dir name; validated by writeTool/safeToolId)
 * @param spec.name        human name
 * @param spec.description what it does
 * @param spec.match       URL match pattern(s) (string | string[]) — required so
 *                         the tool is DISCOVERABLE on the next run for this site
 * @param spec.actions     captured actions (see emitAction's vocab), OR omit and
 *                         pass spec.recording (RecordedAction[]) to derive them
 * @param spec.recording   a recorded flow (record.ts) → actionsFromRecording
 * @returns { meta, script }  — pass straight to writeTool(id,{meta,script})
 *
 * The emitted tool:
 *  - exports a step-structured `steps` array (one step per captured action) AND a
 *    back-compat `run` shim (same convention as the seed tools),
 *  - marks each side-effecting action sideEffect:true (so the runner gates +
 *    never re-fires it on resume),
 *  - declares the same steps in tool.json (advisory mirror for help/discovery),
 *  - sets `status: 'candidate'` — it is NOT trusted until promoteIfHealthy() flips
 *    it to active after a successful run or two.
 *
 * Throws on a PHI leak (a literal value in a captured fill) or an unknown verb.
 */
export function scaffoldTool(spec = {}) {
  const { id, name, description, match } = spec;
  if (!id) throw new Error('scaffoldTool needs an id');
  if (!match || (Array.isArray(match) && !match.length)) {
    throw new Error('scaffoldTool needs a match pattern so the tool is discoverable');
  }
  let actions = spec.actions;
  if (!actions && spec.recording) actions = actionsFromRecording(spec.recording);
  if (!Array.isArray(actions) || !actions.length) {
    throw new Error('scaffoldTool needs a non-empty actions[] (or a recording)');
  }

  const declaredSteps = [];
  const stepFns = [];
  let mergedParams = {};
  actions.forEach((action, i) => {
    const { code, params, sideEffect } = emitAction(action);
    const sName = stepName(action.name || action.verb, i);
    mergedParams = { ...mergedParams, ...params };
    declaredSteps.push({
      name: sName,
      sideEffect: !!sideEffect,
      description: action.description || `${action.verb}${action.selector ? ` ${action.selector}` : ''}${action.url ? ` ${action.url}` : ''}`,
    });
    stepFns.push({ sName, code, sideEffect: !!sideEffect, verb: action.verb });
  });

  // Channel = NON-PHI label the agent reads (registry.mjs). When the OPERATIVE
  // work of the solve was the intercepted API request(s) — i.e. every value-
  // bearing action is a `net-replay` (goto/wait are inert scaffolding) — the tool
  // is an HTTP tool: its steps ARE the site's own request, so the browser can be
  // skipped. Otherwise it stays 'browser' (default). This is a label, NOT a router.
  const channel = channelForActions(actions);

  const meta = {
    id,
    name: name || id,
    description:
      (description || `Auto-emitted from a full-agent solve. ${actions.length} step(s).`) +
      ' (candidate — emitted by the promotion hook; promoted to active after it passes a run or two.)',
    match,
    version: '0.1',
    status: 'candidate',
    ...(channel === 'http' ? { channel } : {}), // omit when default (browser)
    params: mergedParams,
    steps: declaredSteps,
  };

  const script = renderScript(meta, stepFns);
  return { meta, script };
}

/** Render the tool.mjs source: a `<verb>` function per step, the authoritative
 *  `steps` export, and a back-compat `run` shim — mirroring the seed tools. The
 *  emitted ctx is the runner's ctx; we add two thin helpers via ctx that the
 *  runner provides for refs/replay (ctx.fillRef, ctx.replay) — see runner wiring. */
function renderScript(meta, stepFns) {
  const lines = [];
  lines.push(`// ${meta.name} — AUTO-EMITTED candidate tool (promotion hook).`);
  lines.push(`//`);
  lines.push(`// Scaffolded from a full-agent (raw-driver) solve so the next run on this`);
  lines.push(`// site lands at tier 2 (deterministic tool) instead of the slow agent. It is`);
  lines.push(`// status:candidate until it passes a run or two (toolHealth) — review the`);
  lines.push(`// selectors + step side-effect marks before trusting it. NON-PHI: any value`);
  lines.push(`// is a param or a placeholder KEY resolved at run time, never inlined.`);
  lines.push(`//`);
  lines.push(`// ctx = { page, loc, log, state, params, ToolError, fillRef, replay, ... }`);
  lines.push(``);
  // Pull loc off ctx for terse step bodies (the runner passes it in ctx).
  for (const s of stepFns) {
    lines.push(`async function ${jsFnName(s.sName)}(ctx, params, state) {`);
    lines.push(`  const { page, loc } = ctx;`);
    for (const c of s.code) lines.push(c);
    lines.push(`  return {};`);
    lines.push(`}`);
    lines.push(``);
  }
  lines.push(`export const steps = [`);
  for (const s of stepFns) {
    lines.push(`  { name: ${JSON.stringify(s.sName)}, sideEffect: ${s.sideEffect}, run: ${jsFnName(s.sName)} },`);
  }
  lines.push(`];`);
  lines.push(``);
  lines.push(`// Back-compat shim: drive the steps in order for a direct importer.`);
  lines.push(`export async function run(ctx, params) {`);
  lines.push(`  const state = ctx.state || (ctx.state = {});`);
  lines.push(`  let r = {};`);
  lines.push(`  for (const s of steps) r = (await s.run(ctx, params, state)) || r;`);
  lines.push(`  return r;`);
  lines.push(`}`);
  lines.push(``);
  return lines.join('\n');
}

/** A legal JS identifier from a step name (hyphens → underscores). */
function jsFnName(sName) {
  return 'step_' + String(sName).replace(/[^a-z0-9_]+/gi, '_');
}

// ─── candidate → active promotion ────────────────────────────────────────────
// A candidate tool is one the promotion hook emitted but hasn't proven yet. It is
// PROMOTED to active once it has accumulated enough clean runs. The threshold:
//
//   PROMOTE_MIN_SUCCESSES successful runs AND no failure since the last success
//   (success_rate at/above PROMOTE_MIN_RATE).
//
// Conservative on purpose: a candidate that fails stays candidate (the agent will
// repair it first); only a tool that actually works for real graduates. The
// inverse — demoting a flaky active tool — is left to the existing health surface.

export const PROMOTE_MIN_SUCCESSES = 2;   // needs to actually work a couple times
export const PROMOTE_MIN_RATE = 100;      // and not have failed since (rate == 100)

/** Given a tool's current status + its runs.jsonl health, decide the next status.
 *  Pure: returns { status, changed, reason }. Only ever promotes candidate→active;
 *  never touches a non-candidate. */
export function promotionDecision(status, health) {
  if (status !== 'candidate') {
    return { status, changed: false, reason: 'not a candidate' };
  }
  const successes = health?.successes ?? 0;
  const rate = health?.success_rate;
  if (successes >= PROMOTE_MIN_SUCCESSES && rate === PROMOTE_MIN_RATE) {
    return {
      status: 'active',
      changed: true,
      reason: `${successes} clean runs (rate ${rate}%) ≥ threshold — promoting candidate → active`,
    };
  }
  return {
    status: 'candidate',
    changed: false,
    reason: `still proving: ${successes}/${PROMOTE_MIN_SUCCESSES} clean runs, rate ${rate == null ? 'n/a' : rate + '%'}`,
  };
}
