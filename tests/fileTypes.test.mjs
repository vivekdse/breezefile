// fm-o5z8 — unit tests for the PURE file-type registry helpers
// (src/fileTypes.mjs). No Electron/localStorage; isEditable takes the set
// explicitly. Covers defaults, user-added, and user-removed extensions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EDITABLE_EXTS,
  normalizeExt,
  isEditable,
  extOf,
} from '../src/fileTypes.mjs';

test('normalizeExt strips dots, lowercases, trims', () => {
  assert.equal(normalizeExt('MD'), 'md');
  assert.equal(normalizeExt('.md'), 'md');
  assert.equal(normalizeExt('..md'), 'md');
  assert.equal(normalizeExt('  Json '), 'json');
  assert.equal(normalizeExt(''), '');
  assert.equal(normalizeExt(undefined), '');
});

test('extOf returns the normalized extension of a path/name', () => {
  assert.equal(extOf('/home/u/notes.md'), 'md');
  assert.equal(extOf('README.TXT'), 'txt');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('Makefile'), ''); // no dot
  assert.equal(extOf('.gitignore'), ''); // leading-dot dotfile
  assert.equal(extOf('weird.'), ''); // trailing dot
});

test('isEditable: defaults — md/mdx/txt/json/yaml are editable', () => {
  const defaults = new Set(DEFAULT_EDITABLE_EXTS);
  for (const ext of ['md', 'mdx', 'txt', 'json', 'yaml', 'yml']) {
    assert.equal(isEditable(ext, defaults), true, `${ext} should be editable`);
  }
  // Non-text binaries are NOT in the default seed.
  for (const ext of ['png', 'pdf', 'mp4', 'xlsx']) {
    assert.equal(isEditable(ext, defaults), false, `${ext} should not be editable`);
  }
});

test('isEditable: normalizes the queried ext (dot / case)', () => {
  const defaults = new Set(DEFAULT_EDITABLE_EXTS);
  assert.equal(isEditable('.MD', defaults), true);
  assert.equal(isEditable('JSON', defaults), true);
  assert.equal(isEditable('', defaults), false);
});

test('isEditable: user-added extension becomes editable', () => {
  const base = new Set(DEFAULT_EDITABLE_EXTS);
  assert.equal(isEditable('foo', base), false);
  const added = new Set([...base, 'foo']);
  assert.equal(isEditable('foo', added), true);
  assert.equal(isEditable('.FOO', added), true);
});

test('isEditable: user-removed extension is no longer editable', () => {
  const without = new Set(DEFAULT_EDITABLE_EXTS.filter((e) => e !== 'json'));
  assert.equal(isEditable('json', without), false);
  // Removing one does not affect the others.
  assert.equal(isEditable('md', without), true);
});

test('isEditable: accepts any iterable (array) for the set', () => {
  assert.equal(isEditable('md', ['md', 'txt']), true);
  assert.equal(isEditable('png', ['md', 'txt']), false);
  // empty set => nothing editable
  assert.equal(isEditable('md', []), false);
});
