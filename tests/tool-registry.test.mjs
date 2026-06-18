// Unit tests for the Tool Repository data model (electron/browser/tools/
// registry.mjs). Pure functions only — no browser, no app. Uses a temp
// $BREEZE_TOOLS_DIR so it never touches the real repository.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  EXIT,
  ERROR_CATEGORY,
  ToolError,
  validateTool,
  patternMatches,
  toolMatchesUrl,
  loadTool,
  listTools,
  toolsForUrl,
  toolHealth,
  recordRun,
} from '../electron/browser/tools/registry.mjs';

let dir;

function makeTool(id, meta, script = 'export async function run(){return {}}') {
  const base = join(dir, id);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'tool.json'), JSON.stringify({ id, ...meta }));
  writeFileSync(join(base, 'tool.mjs'), script);
  return base;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'bt-reg-'));
  process.env.BREEZE_TOOLS_DIR = dir;
});
after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── exit-code / error-category contract ─────────────────────────────────────
test('exit codes match the documented taxonomy', () => {
  assert.equal(EXIT.SUCCESS, 0);
  assert.equal(EXIT.FAILURE, 1);
  assert.equal(EXIT.VALIDATION, 2);
  assert.equal(EXIT.TIMEOUT, 3);
  assert.equal(EXIT.AUTH, 4);
  assert.equal(EXIT.PAGE_CHANGED, 5);
  assert.equal(EXIT.PARTIAL, 6);
  assert.equal(EXIT.PRECONDITION, 7);
  assert.equal(EXIT.INTERRUPTED, 8);
});

test('error categories map to the right exit codes', () => {
  assert.equal(ERROR_CATEGORY.selector_not_found, EXIT.PAGE_CHANGED);
  assert.equal(ERROR_CATEGORY.auth_failed, EXIT.AUTH);
  assert.equal(ERROR_CATEGORY.timeout, EXIT.TIMEOUT);
  assert.equal(ERROR_CATEGORY.precondition_not_met, EXIT.PRECONDITION);
  assert.equal(ERROR_CATEGORY.rate_limited, EXIT.TIMEOUT);
  assert.equal(ERROR_CATEGORY.partial_success, EXIT.PARTIAL);
});

test('ToolError carries category + extra', () => {
  const e = new ToolError('auth_failed', 'nope', { final_url: 'x' });
  assert.equal(e.category, 'auth_failed');
  assert.equal(e.message, 'nope');
  assert.deepEqual(e.extra, { final_url: 'x' });
});

// ─── validation ──────────────────────────────────────────────────────────────
test('validateTool requires id/name/description/match', () => {
  assert.equal(validateTool({ id: 'a', name: 'A', description: 'd', match: 'x' }).ok, true);
  const bad = validateTool({ id: 'a' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /name/.test(e)));
  assert.ok(bad.errors.some((e) => /match/.test(e)));
});

test('validateTool rejects empty match and bad status', () => {
  assert.equal(validateTool({ id: 'a', name: 'A', description: 'd', match: [] }).ok, false);
  assert.equal(
    validateTool({ id: 'a', name: 'A', description: 'd', match: 'x', status: 'bogus' }).ok,
    false,
  );
});

// ─── URL matching ────────────────────────────────────────────────────────────
test('patternMatches: substring (case-insensitive)', () => {
  assert.equal(patternMatches('availity.com', 'https://AVAILITY.com/x'), true);
  assert.equal(patternMatches('availity.com', 'https://google.com'), false);
});

test('patternMatches: glob with * and ?', () => {
  assert.equal(patternMatches('*.demo.test/login*', 'https://app.demo.test/login?x=1'), true);
  assert.equal(patternMatches('*.demo.test/login*', 'https://app.demo.test/home'), false);
  assert.equal(patternMatches('*', 'https://anything.example'), true);
});

test('toolMatchesUrl handles single or array match', () => {
  assert.equal(toolMatchesUrl({ match: 'example.com' }, 'https://example.com/x'), true);
  assert.equal(toolMatchesUrl({ match: ['a.com', 'b.com'] }, 'https://b.com/y'), true);
  assert.equal(toolMatchesUrl({ match: ['a.com'] }, 'https://z.com'), false);
});

// ─── load / list / discover ──────────────────────────────────────────────────
test('loadTool reads tool.json and forces id from dir name', () => {
  makeTool('login-x', { name: 'L', description: 'd', match: 'foo.com', id: 'WRONG' });
  const t = loadTool('login-x');
  assert.equal(t.meta.id, 'login-x'); // dir name wins over a stale id field
  assert.equal(t.meta.name, 'L');
});

test('listTools returns every tool dir, skips dotfiles', () => {
  // (login-x already exists from the previous test)
  makeTool('extract-y', { name: 'E', description: 'd', match: '*' });
  mkdirSync(join(dir, '.hidden'), { recursive: true });
  const ids = listTools().map((t) => t.id).sort();
  assert.ok(ids.includes('login-x'));
  assert.ok(ids.includes('extract-y'));
  assert.ok(!ids.includes('.hidden'));
});

test('toolsForUrl filters by match and excludes deprecated', () => {
  makeTool('only-acme', { name: 'A', description: 'd', match: 'acme.com' });
  makeTool('dead-tool', { name: 'D', description: 'd', match: '*', status: 'deprecated' });
  const ids = toolsForUrl('https://acme.com/login').map((t) => t.id);
  assert.ok(ids.includes('only-acme'));
  assert.ok(ids.includes('extract-y')); // matches '*'
  assert.ok(!ids.includes('dead-tool')); // deprecated excluded
  assert.ok(!ids.includes('login-x')); // foo.com doesn't match acme.com
});

// ─── health ──────────────────────────────────────────────────────────────────
test('toolHealth summarizes runs.jsonl', () => {
  const runs = join(dir, 'only-acme', 'runs.jsonl');
  appendFileSync(runs, JSON.stringify({ timestamp: '2026-06-18T00:00:00Z', status: 'success' }) + '\n');
  appendFileSync(runs, JSON.stringify({ timestamp: '2026-06-18T01:00:00Z', status: 'failure' }) + '\n');
  appendFileSync(runs, JSON.stringify({ timestamp: '2026-06-18T02:00:00Z', status: 'success' }) + '\n');
  const h = toolHealth(runs);
  assert.equal(h.runs, 3);
  assert.equal(h.successes, 2);
  assert.equal(h.success_rate, 67); // round(2/3*100)
  assert.equal(h.last_run, '2026-06-18T02:00:00Z');
  assert.equal(h.last_failure, '2026-06-18T01:00:00Z');
});

test('toolHealth is empty for a tool with no history', () => {
  const h = toolHealth(join(dir, 'extract-y', 'runs.jsonl'));
  assert.equal(h.runs, 0);
  assert.equal(h.success_rate, null);
});

test('recordRun never throws on a bad path', () => {
  assert.doesNotThrow(() => recordRun('/no/such/dir/runs.jsonl', { status: 'success' }));
});
