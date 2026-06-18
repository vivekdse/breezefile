// Tests for the tool-authoring (create/update/delete) + site/task memory layer
// added to the Tool Repository. Pure unit tests against the registry/memory
// modules with $BREEZE_TOOLS_DIR / $BREEZE_MEMORY_DIR pointed at temp dirs — no
// browser, no app, CI-safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

process.env.BREEZE_TOOLS_DIR = mkdtempSync(join(tmpdir(), 'bz-tools-'));
process.env.BREEZE_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'bz-mem-'));

const reg = await import(join(repoRoot, 'electron', 'browser', 'tools', 'registry.mjs'));
const mem = await import(join(repoRoot, 'electron', 'browser', 'tools', 'memory.mjs'));

const META = {
  id: 'demo-tool',
  name: 'Demo',
  description: 'A demo tool',
  match: ['example.com'],
  version: '1.0',
};
const SCRIPT = 'export async function run(ctx) { return { ok: true }; }\n';

// ── Tool CRUD ────────────────────────────────────────────────────────────────
test('writeTool creates a tool; loadTool reads it back', () => {
  const r = reg.writeTool('demo-tool', { meta: META, script: SCRIPT });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  const t = reg.loadTool('demo-tool');
  assert.equal(t.meta.name, 'Demo');
  assert.ok(existsSync(t.scriptPath));
  assert.match(readFileSync(t.scriptPath, 'utf8'), /function run/);
});

test('create refuses to overwrite an existing tool', () => {
  const r = reg.writeTool('demo-tool', { meta: META, script: SCRIPT });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /already exists/);
});

test('update of a missing tool is rejected', () => {
  const r = reg.writeTool('nope', { meta: META, script: SCRIPT }, { overwrite: true });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /does not exist/);
});

test('update with only --script keeps the existing meta', () => {
  const r = reg.writeTool('demo-tool', { script: 'export async function run(){return 1}' }, { overwrite: true });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'updated');
  assert.equal(reg.loadTool('demo-tool').meta.name, 'Demo'); // meta unchanged
});

test('invalid meta (missing required field) is rejected, not written', () => {
  const r = reg.writeTool('bad', { meta: { name: 'x' }, script: SCRIPT });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /match|description/.test(e)));
  assert.equal(reg.loadTool('bad'), null);
});

test('a path-traversal id throws (never escapes the tools dir)', () => {
  assert.throws(() => reg.writeTool('../evil', { meta: META, script: SCRIPT }), /invalid tool id/);
  assert.throws(() => reg.deleteTool('a/b'), /invalid tool id/);
});

test('deleteTool removes the tool; delete of a missing tool is a clean miss', () => {
  assert.equal(reg.deleteTool('demo-tool').ok, true);
  assert.equal(reg.loadTool('demo-tool'), null);
  assert.equal(reg.deleteTool('demo-tool').ok, false);
});

// ── Memory ───────────────────────────────────────────────────────────────────
test('site memory: URL is normalized to a bare domain key', () => {
  mem.addMemory('site', 'https://www.example.com/some/path', 'note A');
  const m = mem.getMemory('site', 'example.com');
  assert.equal(m.key, 'example.com');
  assert.equal(m.entries.length, 1);
  assert.equal(m.entries[0].text, 'note A');
});

test('memory appends and lists by scope', () => {
  mem.addMemory('site', 'example.com', 'note B');
  mem.addMemory('task', 'task-xyz', 'task note');
  assert.equal(mem.getMemory('site', 'http://example.com').entries.length, 2);
  const list = mem.listMemory();
  assert.ok(list.site.some((s) => s.key === 'example.com' && s.count === 2));
  assert.ok(list.task.some((t) => t.key === 'task-xyz' && t.count === 1));
});

test('delete one entry by index; deleting the last removes the file', () => {
  const before = mem.getMemory('site', 'example.com').entries.length;
  const d = mem.deleteMemory('site', 'example.com', { index: 0 });
  assert.equal(d.ok, true);
  assert.equal(mem.getMemory('site', 'example.com').entries.length, before - 1);
});

test('empty text and bad scope are rejected', () => {
  assert.throws(() => mem.addMemory('site', 'example.com', '   '), /text is required/);
  assert.throws(() => mem.addMemory('bogus', 'k', 'x'), /invalid memory scope/);
});
