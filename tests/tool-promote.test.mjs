// Tests for auto-promotion (Operator Speed): a full-agent solve emits a reusable
// CANDIDATE tool. Pins:
//   - scaffoldTool() emits a VALID, step-structured tool marked status:candidate,
//   - the emitted tool.mjs really imports and exports a steps[] the registry
//     normalizes (so the runner can drive + resume it),
//   - side-effecting captured actions (mutating net-replay) become sideEffect:true
//     steps (so the runner gates + never re-fires them),
//   - the PHI guard: a captured fill carrying a LITERAL value is refused; a
//     placeholder KEY / {{param}} ref is accepted,
//   - candidate → active promotion only after enough clean runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import {
  scaffoldTool,
  actionsFromRecording,
  promotionDecision,
  looksLikeLiteralValue,
  PROMOTE_MIN_SUCCESSES,
} from '../electron/browser/tools/promote.mjs';
import {
  validateTool,
  normalizeSteps,
  writeTool,
  loadTool,
} from '../electron/browser/tools/registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A captured raw-driver sequence solving a reusable flow: navigate, fill a
// field from a param + a placeholder KEY, and grab the data via the API shortcut.
const ACTIONS = [
  { verb: 'goto', url: 'https://acme.example/login' },
  { verb: 'fill', selector: '#user', ref: '{{username}}' },
  { verb: 'fill', selector: '#ssn', ref: 'patient.ssn' }, // placeholder KEY, not a value
  { verb: 'net-replay', method: 'GET', url: 'https://acme.example/api/orders' },
];

// ─── scaffoldTool: a valid, step-structured candidate ────────────────────────
test('scaffoldTool emits a valid tool marked status:candidate with declared steps', () => {
  const { meta } = scaffoldTool({
    id: 'acme-orders',
    name: 'Acme Orders',
    match: ['acme.example'],
    actions: ACTIONS,
  });
  assert.equal(meta.status, 'candidate');
  assert.equal(validateTool(meta).ok, true);
  assert.equal(meta.steps.length, ACTIONS.length);
  // The {{username}} ref became a declared param; the placeholder KEY did not.
  assert.equal(meta.params.username.required, true);
  assert.equal('ssn' in meta.params, false);
});

test('a mutating captured net-replay becomes a sideEffect:true step (gated)', () => {
  const { meta } = scaffoldTool({
    id: 'acme-submit',
    match: ['acme.example'],
    actions: [
      { verb: 'goto', url: 'https://acme.example/f' },
      { verb: 'net-replay', method: 'POST', url: 'https://acme.example/api/submit' },
    ],
  });
  const submitStep = meta.steps.find((s) => s.name.startsWith('net-replay'));
  assert.equal(submitStep.sideEffect, true);
  // a GET replay stays idempotent
  const get = scaffoldTool({ id: 'acme-read', match: ['acme.example'], actions: [{ verb: 'net-replay', method: 'GET', url: 'https://acme.example/api/x' }] });
  assert.equal(get.meta.steps[0].sideEffect, false);
});

test('the emitted tool.mjs imports and exposes a normalizable steps[]', async () => {
  const { meta, script } = scaffoldTool({ id: 'acme-orders', name: 'Acme Orders', match: ['acme.example'], actions: ACTIONS });
  // Write it to a temp file and actually import it — this proves the generated
  // source is syntactically valid JS and exports a real steps[] + run shim.
  const dir = mkdtempSync(join(tmpdir(), 'emit-'));
  try {
    const file = join(dir, 'tool.mjs');
    writeFileSync(file, script);
    const mod = await import(pathToFileURL(file).href);
    const n = normalizeSteps(mod);
    assert.equal(n.ok, true, n.errors.join('; '));
    assert.equal(n.steps.length, ACTIONS.length);
    assert.equal(typeof mod.run, 'function'); // back-compat shim
    // declared steps in meta mirror the module's steps (name + sideEffect)
    assert.deepEqual(n.steps.map((s) => s.name), meta.steps.map((s) => s.name));
    assert.deepEqual(n.steps.map((s) => s.sideEffect), meta.steps.map((s) => s.sideEffect));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldTool writes through writeTool as a discoverable candidate', () => {
  const toolsDir = mkdtempSync(join(tmpdir(), 'emit-tools-'));
  process.env.BREEZE_TOOLS_DIR = toolsDir;
  try {
    const { meta, script } = scaffoldTool({ id: 'acme-orders', name: 'Acme Orders', match: ['acme.example'], actions: ACTIONS });
    const r = writeTool('acme-orders', { meta, script });
    assert.equal(r.ok, true);
    const t = loadTool('acme-orders', toolsDir);
    assert.equal(t.meta.status, 'candidate');
  } finally {
    rmSync(toolsDir, { recursive: true, force: true });
    delete process.env.BREEZE_TOOLS_DIR;
  }
});

// ─── PHI guard ───────────────────────────────────────────────────────────────
test('looksLikeLiteralValue: placeholder keys + param refs are NOT literals', () => {
  assert.equal(looksLikeLiteralValue('patient.ssn'), false);
  assert.equal(looksLikeLiteralValue('me.npi'), false);
  assert.equal(looksLikeLiteralValue('{{username}}'), false);
  assert.equal(looksLikeLiteralValue(':username'), false);
  // an actual value IS a literal
  assert.equal(looksLikeLiteralValue('123-45-6789'), true);
  assert.equal(looksLikeLiteralValue('hunter2'), true);
});

test('scaffoldTool REFUSES a captured fill that carries a literal value (PHI leak)', () => {
  assert.throws(
    () =>
      scaffoldTool({
        id: 'leaky',
        match: ['acme.example'],
        actions: [{ verb: 'fill', selector: '#ssn', value: '123-45-6789' }],
      }),
    /literal value|placeholder/i,
  );
});

test('scaffoldTool needs an id, a match, and non-empty actions', () => {
  assert.throws(() => scaffoldTool({ match: ['x'], actions: ACTIONS }), /needs an id/);
  assert.throws(() => scaffoldTool({ id: 'x', actions: ACTIONS }), /match/);
  assert.throws(() => scaffoldTool({ id: 'x', match: ['x'], actions: [] }), /non-empty actions/);
});

// ─── recording → actions ─────────────────────────────────────────────────────
test('actionsFromRecording maps a record.ts flow to captured actions (KEYS only)', () => {
  const recorded = [
    { action: 'navigate', url: 'https://acme.example/login', to: 'https://acme.example/login' },
    { action: 'input', best: { selector: '#user' }, placeholder: 'me.portal_login' },
    { action: 'click', best: { selector: 'button[type=submit]' } },
  ];
  const actions = actionsFromRecording(recorded);
  assert.deepEqual(actions.map((a) => a.verb), ['goto', 'fill', 'click']);
  // the recorded input carried a placeholder KEY, never a value
  assert.equal(actions[1].ref, 'me.portal_login');
  // scaffolding the derived actions succeeds (the KEY is not a literal)
  const { meta } = scaffoldTool({ id: 'acme-rec', match: ['acme.example'], recording: recorded });
  assert.equal(meta.status, 'candidate');
  assert.equal(meta.steps.length, 3);
});

// ─── candidate → active promotion threshold ──────────────────────────────────
test('promotionDecision: a candidate promotes only after enough clean runs', () => {
  // not enough runs yet → stays candidate
  assert.equal(promotionDecision('candidate', { successes: 1, success_rate: 100 }).changed, false);
  // a failure in history (rate < 100) → stays candidate even with enough successes
  assert.equal(
    promotionDecision('candidate', { successes: PROMOTE_MIN_SUCCESSES, success_rate: 80 }).changed,
    false,
  );
  // enough clean runs at 100% → promote
  const d = promotionDecision('candidate', { successes: PROMOTE_MIN_SUCCESSES, success_rate: 100 });
  assert.equal(d.changed, true);
  assert.equal(d.status, 'active');
});

test('promotionDecision never touches a non-candidate tool', () => {
  const d = promotionDecision('active', { successes: 99, success_rate: 100 });
  assert.equal(d.changed, false);
  assert.equal(d.status, 'active');
});
