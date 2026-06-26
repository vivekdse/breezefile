// fm-mp1 / fm-xr0 — unit tests for the pure selector-over-entries helpers that
// back filter-tabs (which walked entries match?) and frozen tags (which paths
// match right now?). Runs under `node --test tests/` with no Electron — the
// helpers are pure (the Electron host supplies entries via fs:walkScope; tests
// pass literal Entry-shaped rows).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, computeSnapshot } from '../src/filterEntries.mjs';

// Entry-shaped rows (the repo's Entry: path/name/ext/size/mtimeMs/kind/isHidden).
// tagDsl normalizes both Entry and DSL field names, so these match directly.
const entries = [
  { path: '/h/a/report.pdf', name: 'report.pdf', ext: 'pdf', size: 8 * 1024 * 1024, kind: 'file' },
  { path: '/h/a/notes.pdf', name: 'notes.pdf', ext: 'pdf', size: 1 * 1024 * 1024, kind: 'file' },
  { path: '/h/b/photo.png', name: 'photo.png', ext: 'png', size: 2 * 1024 * 1024, kind: 'file' },
  { path: '/h/b', name: 'b', size: 0, kind: 'dir' },
];

test('filterEntries: simple field selector keeps matching rows in order', () => {
  const out = filterEntries(entries, 'ext = pdf');
  assert.deepEqual(
    out.map((e) => e.path),
    ['/h/a/report.pdf', '/h/a/notes.pdf'],
  );
});

test('filterEntries: compound selector (ext + size) narrows further', () => {
  const out = filterEntries(entries, 'ext = pdf and size > 4MB');
  assert.deepEqual(out.map((e) => e.path), ['/h/a/report.pdf']);
});

test('filterEntries: is_dir truthiness shorthand selects directories', () => {
  const out = filterEntries(entries, 'is_dir');
  assert.deepEqual(out.map((e) => e.path), ['/h/b']);
});

test('filterEntries: resolves tag:name atoms via the supplied tag list', () => {
  const tags = [{ name: 'pdfs', selector: 'ext = pdf', mode: 'live' }];
  const out = filterEntries(entries, 'tag:pdfs and size > 4MB', { tags });
  assert.deepEqual(out.map((e) => e.path), ['/h/a/report.pdf']);
});

test('filterEntries: a bad selector throws (caller decides UX)', () => {
  assert.throws(() => filterEntries(entries, 'ext === '), /position|expected|invalid|unexpected/i);
});

test('filterEntries: empty / nullish entries → empty result', () => {
  assert.deepEqual(filterEntries([], 'ext = pdf'), []);
  assert.deepEqual(filterEntries(undefined, 'ext = pdf'), []);
});

test('computeSnapshot: captures the matching PATHS (deduped, in order)', () => {
  const snap = computeSnapshot(entries, 'ext = pdf');
  assert.deepEqual(snap, ['/h/a/report.pdf', '/h/a/notes.pdf']);
});

test('computeSnapshot: dedupes repeated paths and skips path-less rows', () => {
  const dupes = [
    { path: '/x.pdf', ext: 'pdf' },
    { path: '/x.pdf', ext: 'pdf' }, // duplicate path
    { ext: 'pdf' }, // no path → skipped
  ];
  assert.deepEqual(computeSnapshot(dupes, 'ext = pdf'), ['/x.pdf']);
});

test('computeSnapshot: frozen-then-resolve round-trip matches a frozen tag', () => {
  // The snapshot computed here is exactly what a frozen tag pins; dslTagResolve
  // (tested separately) then tests membership by path against it. Sanity-check
  // the two halves agree on the same path set.
  const snap = computeSnapshot(entries, 'ext = pdf and size > 4MB');
  assert.deepEqual(snap, ['/h/a/report.pdf']);
  assert.ok(snap.includes('/h/a/report.pdf'));
  assert.ok(!snap.includes('/h/b/photo.png'));
});

test('filterEntries: now injection makes relative-date selectors deterministic', () => {
  const now = 1_000_000_000_000;
  const rows = [
    { path: '/recent', mtimeMs: now - 1 * 24 * 60 * 60 * 1000 }, // 1 day ago
    { path: '/old', mtimeMs: now - 30 * 24 * 60 * 60 * 1000 }, // 30 days ago
  ];
  const out = filterEntries(rows, 'mtime > now-7d', { now });
  assert.deepEqual(out.map((e) => e.path), ['/recent']);
});
