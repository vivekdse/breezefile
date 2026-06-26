// fm-j80 — unit tests for the pure DSL parser & evaluator (src/tagDsl.mjs).
// Runs under `node --test tests/` with no Electron/fs. Determinism comes from
// the injectable opts.now; tag:name atoms are exercised via a stub resolver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, ParseError, FIELDS, _internal } from '../src/tagDsl.mjs';

// A fixed clock so relative-date predicates are deterministic.
// 2026-06-25T00:00:00Z
const NOW = Date.parse('2026-06-25T00:00:00Z');
const opts = { now: NOW };

// Helper: parse + evaluate in one shot.
const ev = (q, row, o = opts) => evaluate(parse(q), row, o);

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── Comparison operators ──────────────────────────────────────────────────
test('= and != on strings', () => {
  assert.equal(ev('name = readme.md', { name: 'readme.md' }), true);
  assert.equal(ev('name = readme.md', { name: 'other.md' }), false);
  assert.equal(ev('name != readme.md', { name: 'other.md' }), true);
  assert.equal(ev('ext = "txt"', { name: 'a.txt' }), true);
});

test('numeric > < >= <= on size', () => {
  const row = { size: 5 * MB };
  assert.equal(ev('size > 1MB', row), true);
  assert.equal(ev('size < 1MB', row), false);
  assert.equal(ev('size >= 5MB', row), true);
  assert.equal(ev('size <= 5MB', row), true);
  assert.equal(ev('size = 5MB', row), true);
  assert.equal(ev('size != 5MB', row), false);
});

test('depth numeric comparisons', () => {
  assert.equal(ev('depth = 3', { path: '/a/b/c' }), true);
  assert.equal(ev('depth > 2', { path: '/a/b/c' }), true);
  assert.equal(ev('depth >= 3', { depth: 3 }), true);
});

test('~ and !~ match (regex) operators', () => {
  assert.equal(ev('name ~ "^foo"', { name: 'foobar' }), true);
  assert.equal(ev('name ~ "^foo"', { name: 'barfoo' }), false);
  assert.equal(ev('name !~ "^foo"', { name: 'barfoo' }), true);
  assert.equal(ev('path ~ "/node_modules/"', { path: '/x/node_modules/y' }), true);
});

// ── Unit literals (size + duration) ────────────────────────────────────────
test('size unit literals MB/GB/KB and binary KiB', () => {
  assert.equal(_internal.parseSizeOrNumber('1MB'), MB);
  assert.equal(_internal.parseSizeOrNumber('1.5GB'), Math.round(1.5 * GB));
  assert.equal(_internal.parseSizeOrNumber('2KB'), 2 * KB); // binary KB = 1024
  assert.equal(_internal.parseSizeOrNumber('2KiB'), 2 * KB);
  assert.equal(_internal.parseSizeOrNumber('512'), 512); // bare
});

test('size with decimal unit in a predicate', () => {
  assert.equal(ev('size > 1.5GB', { size: 2 * GB }), true);
  assert.equal(ev('size > 1.5GB', { size: 1 * GB }), false);
});

test('duration unit literals d/h via parseDurationMs', () => {
  assert.equal(_internal.parseDurationMs('7d'), 7 * DAY);
  assert.equal(_internal.parseDurationMs('2h'), 2 * HOUR);
  assert.equal(_internal.parseDurationMs('30min'), 30 * 60 * 1000);
});

// ── Date / relative-date parsing ───────────────────────────────────────────
test('now resolves via injectable clock', () => {
  // mtime < now is true for any past file
  assert.equal(ev('mtime < now', { mtime: NOW - DAY }), true);
  assert.equal(ev('mtime > now', { mtime: NOW - DAY }), false);
});

test('relative dates now-30d / now-7d', () => {
  const recent = { mtime: NOW - 3 * DAY };
  const old = { mtime: NOW - 60 * DAY };
  assert.equal(ev('mtime > now-30d', recent), true);
  assert.equal(ev('mtime > now-30d', old), false);
  assert.equal(ev('mtime < now-7d', old), true);
});

test('now+2h future offset', () => {
  const lit = _internal.parseNowExpr('now+2h');
  assert.deepEqual(lit, { kind: 'time', nowOffsetMs: 2 * HOUR });
});

test('ISO date literals (date and datetime)', () => {
  const row = { mtime: Date.parse('2026-03-15T00:00:00Z') };
  assert.equal(ev('mtime > 2026-01-01', row), true);
  assert.equal(ev('mtime < 2026-06-01', row), true);
  assert.equal(ev('mtime > 2026-03-15T12:00:00Z', row), false);
});

test('bare epoch-ms time literal', () => {
  const row = { mtime: 1000 };
  assert.equal(ev('mtime = 1000', row), true);
});

// ── glob ───────────────────────────────────────────────────────────────────
test('glob operator on name', () => {
  assert.equal(ev('name glob "*.txt"', { name: 'notes.txt' }), true);
  assert.equal(ev('name glob "*.txt"', { name: 'notes.md' }), false);
  assert.equal(ev('name glob "img_???.png"', { name: 'img_012.png' }), true);
  assert.equal(ev('name glob "img_???.png"', { name: 'img_1.png' }), false);
});

test('glob * does not cross / but ** does', () => {
  assert.equal(_internal.globToRegExp('src/*').test('src/a'), true);
  assert.equal(_internal.globToRegExp('src/*').test('src/a/b'), false);
  assert.equal(_internal.globToRegExp('src/**').test('src/a/b'), true);
});

test('glob character class', () => {
  assert.equal(ev('name glob "file[0-9].txt"', { name: 'file3.txt' }), true);
  assert.equal(ev('name glob "file[0-9].txt"', { name: 'fileX.txt' }), false);
  assert.equal(ev('name glob "file[!0-9].txt"', { name: 'fileX.txt' }), true);
});

// ── in ──────────────────────────────────────────────────────────────────────
test('in (...) on ext', () => {
  assert.equal(ev('ext in (png, jpg, gif)', { name: 'a.jpg' }), true);
  assert.equal(ev('ext in (png, jpg, gif)', { name: 'a.pdf' }), false);
  assert.equal(ev('ext in ("png", "jpg")', { ext: 'png' }), true);
});

test('in (...) on numeric depth', () => {
  assert.equal(ev('depth in (1, 2, 3)', { depth: 2 }), true);
  assert.equal(ev('depth in (1, 2, 3)', { depth: 4 }), false);
});

// ── between ──────────────────────────────────────────────────────────────────
test('between on size', () => {
  assert.equal(ev('size between 1MB and 10MB', { size: 5 * MB }), true);
  assert.equal(ev('size between 1MB and 10MB', { size: 20 * MB }), false);
  assert.equal(ev('size between 1MB and 10MB', { size: 1 * MB }), true); // inclusive low
  assert.equal(ev('size between 1MB and 10MB', { size: 10 * MB }), true); // inclusive high
});

test('between on dates', () => {
  const row = { mtime: Date.parse('2026-03-15') };
  assert.equal(ev('mtime between 2026-01-01 and 2026-06-01', row), true);
  assert.equal(ev('mtime between 2026-04-01 and 2026-06-01', row), false);
});

// ── booleans ──────────────────────────────────────────────────────────────
test('bool fields and truthiness shorthand', () => {
  assert.equal(ev('is_dir', { is_dir: true }), true);
  assert.equal(ev('is_dir', { is_dir: false }), false);
  assert.equal(ev('is_dir = true', { is_dir: true }), true);
  assert.equal(ev('is_dir = false', { is_dir: false }), true);
  assert.equal(ev('is_hidden', { is_hidden: true }), true);
  assert.equal(ev('not is_dir', { is_dir: false }), true);
});

test('Entry-shape normalization (kind/mtimeMs/isHidden)', () => {
  assert.equal(ev('is_dir', { kind: 'dir' }), true);
  assert.equal(ev('is_symlink', { kind: 'link' }), true);
  assert.equal(ev('is_hidden', { isHidden: true }), true);
  assert.equal(ev('mtime < now', { mtimeMs: NOW - DAY }), true);
});

// ── derived fields from path ───────────────────────────────────────────────
test('name/ext/parent/depth derived from path', () => {
  const row = { path: '/home/u/docs/report.pdf' };
  assert.equal(ev('name = report.pdf', row), true);
  assert.equal(ev('ext = pdf', row), true);
  assert.equal(ev('parent = /home/u/docs', row), true);
  assert.equal(ev('depth = 4', row), true);
});

// ── combinators + precedence + parens ──────────────────────────────────────
test('and / or precedence: and binds tighter than or', () => {
  // ext=md or ext=txt and size>1MB  ==  ext=md OR (ext=txt AND size>1MB)
  const q = 'ext = md or ext = txt and size > 1MB';
  assert.equal(ev(q, { name: 'a.md', size: 0 }), true); // md branch
  assert.equal(ev(q, { name: 'a.txt', size: 0 }), false); // txt but small
  assert.equal(ev(q, { name: 'a.txt', size: 2 * MB }), true); // txt and big
});

test('parens override precedence', () => {
  const q = '(ext = md or ext = txt) and size > 1MB';
  assert.equal(ev(q, { name: 'a.md', size: 0 }), false);
  assert.equal(ev(q, { name: 'a.md', size: 2 * MB }), true);
});

test('not with parens', () => {
  assert.equal(ev('not (is_dir or is_hidden)', { is_dir: false, is_hidden: false }), true);
  assert.equal(ev('not (is_dir or is_hidden)', { is_dir: true, is_hidden: false }), false);
});

test('nested and/or chains', () => {
  const q = 'size > 1MB and (ext = mp4 or ext = mov) and not is_hidden';
  assert.equal(ev(q, { name: 'v.mp4', size: 5 * MB, is_hidden: false }), true);
  assert.equal(ev(q, { name: 'v.mp4', size: 5 * MB, is_hidden: true }), false);
  assert.equal(ev(q, { name: 'v.txt', size: 5 * MB, is_hidden: false }), false);
});

// ── tag:name self-reference via injectable resolver ────────────────────────
test('tag:name atom resolves via stub resolver', () => {
  const resolver = (name, row) => {
    if (name === 'images') return /\.(png|jpg)$/.test(row.name ?? '');
    if (name === 'big') return (row.size ?? 0) > 1 * MB;
    return false;
  };
  const o = { now: NOW, resolveTag: resolver };
  assert.equal(evaluate(parse('tag:images'), { name: 'a.png' }, o), true);
  assert.equal(evaluate(parse('tag:images'), { name: 'a.txt' }, o), false);
  // combined with a metadata predicate
  assert.equal(
    evaluate(parse('tag:images and size > 1MB'), { name: 'a.png', size: 2 * MB }, o),
    true,
  );
  assert.equal(
    evaluate(parse('tag:images and size > 1MB'), { name: 'a.png', size: 10 }, o),
    false,
  );
  // tag composed with tag
  assert.equal(
    evaluate(parse('tag:images and tag:big'), { name: 'a.png', size: 2 * MB }, o),
    true,
  );
});

test('quoted tag name', () => {
  const o = { resolveTag: (n) => n === 'my tag' };
  assert.equal(evaluate(parse('tag:"my tag"'), {}, o), true);
});

test('tag atom AST shape', () => {
  assert.deepEqual(parse('tag:foo'), { type: 'tag', name: 'foo' });
});

test('tag atom without resolver throws at evaluate time', () => {
  assert.throws(() => evaluate(parse('tag:foo'), {}, { now: NOW }), /resolveTag/);
});

// ── AST shape sanity ────────────────────────────────────────────────────────
test('compare AST shape with size literal in bytes', () => {
  assert.deepEqual(parse('size > 1MB'), {
    type: 'compare',
    field: 'size',
    op: '>',
    value: { kind: 'number', value: MB },
  });
});

test('between AST shape', () => {
  const ast = parse('depth between 1 and 3');
  assert.equal(ast.type, 'between');
  assert.equal(ast.field, 'depth');
  assert.deepEqual(ast.low, { kind: 'number', value: 1 });
  assert.deepEqual(ast.high, { kind: 'number', value: 3 });
});

test('FIELDS catalogue exported and complete', () => {
  for (const f of [
    'name', 'ext', 'path', 'parent', 'depth', 'size', 'mtime', 'ctime',
    'atime', 'birthtime', 'is_dir', 'is_symlink', 'is_hidden', 'mime',
  ]) {
    assert.ok(f in FIELDS, `missing field ${f}`);
  }
});

// ── parse-error cases ────────────────────────────────────────────────────────
test('empty / whitespace query throws', () => {
  assert.throws(() => parse(''), ParseError);
  assert.throws(() => parse('   '), ParseError);
});

test('unknown field throws', () => {
  assert.throws(() => parse('bogus = 1'), /unknown field/);
});

test('unknown size unit throws', () => {
  assert.throws(() => parse('size > 5XB'), /unknown size unit/);
});

test('missing operator throws', () => {
  assert.throws(() => parse('name'), /expected an operator/);
});

test('unbalanced parens throws', () => {
  assert.throws(() => parse('(is_dir'), /expected '\)'/);
});

test('trailing garbage after expression throws', () => {
  assert.throws(() => parse('is_dir bogus'), /after expression/);
});

test('unterminated string throws', () => {
  assert.throws(() => parse('name = "unclosed'), /unterminated string/);
});

test('bad relative date throws', () => {
  assert.throws(() => parse('mtime > now-5x'), /unknown duration unit/);
});

test('invalid ISO date throws', () => {
  assert.throws(() => parse('mtime > 2026-13-99'), /invalid date/);
});

test("'in' with empty list throws", () => {
  assert.throws(() => parse('ext in ()'), /at least one value/);
});

test('lone bang throws a clear error', () => {
  assert.throws(() => parse('name ! foo'), ParseError);
});

test('non-string input to parse throws', () => {
  assert.throws(() => parse(42), /must be a string/);
});

// ── evaluate robustness ─────────────────────────────────────────────────────
test('missing numeric field: > is false, != is true', () => {
  assert.equal(ev('size > 1MB', {}), false);
  assert.equal(ev('size != 1MB', {}), true);
});

test('case-insensitive keywords and field names', () => {
  assert.equal(ev('NAME = a.txt OR ext = md', { name: 'a.txt' }), true);
  assert.equal(ev('IS_DIR AND size > 0', { is_dir: true, size: 1 }), true);
});

test('now as a function thunk works', () => {
  const o = { now: () => NOW };
  assert.equal(evaluate(parse('mtime < now'), { mtime: NOW - 1 }, o), true);
});
