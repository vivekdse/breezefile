// fm-3vl — unit tests for the aggregate-stats helper that backs the
// destructive bulk-verb confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateStats,
  formatBytes,
  oldestYear,
  summarizeStats,
} from '../src/selectionStats.mjs';

const MS_2019 = Date.UTC(2019, 5, 1);
const MS_2021 = Date.UTC(2021, 0, 15);
const MS_2023 = Date.UTC(2023, 11, 31);

test('aggregateStats: count, total size, oldest mtime', () => {
  const rows = [
    { size: 1024, mtimeMs: MS_2023 },
    { size: 2048, mtimeMs: MS_2019 },
    { size: 512, mtimeMs: MS_2021 },
  ];
  const s = aggregateStats(rows);
  assert.equal(s.count, 3);
  assert.equal(s.totalSize, 1024 + 2048 + 512);
  assert.equal(s.oldestMtimeMs, MS_2019);
});

test('aggregateStats: empty input', () => {
  const s = aggregateStats([]);
  assert.deepEqual(s, { count: 0, totalSize: 0, oldestMtimeMs: null });
});

test('aggregateStats: skips missing/non-numeric size and mtime', () => {
  const rows = [
    { mtimeMs: MS_2021 }, // no size
    { size: 1000 }, // no mtime
    { size: 'nope', mtimeMs: 'nope' }, // junk
    { size: 500, mtimeMs: MS_2019 },
  ];
  const s = aggregateStats(rows);
  assert.equal(s.count, 4); // count is the row count, not the valid-field count
  assert.equal(s.totalSize, 1500);
  assert.equal(s.oldestMtimeMs, MS_2019);
});

test('aggregateStats: accepts DSL `mtime` field too', () => {
  const s = aggregateStats([{ size: 10, mtime: MS_2021 }]);
  assert.equal(s.oldestMtimeMs, MS_2021);
});

test('aggregateStats: non-array input is treated as empty', () => {
  assert.deepEqual(aggregateStats(null), { count: 0, totalSize: 0, oldestMtimeMs: null });
  assert.deepEqual(aggregateStats(undefined), { count: 0, totalSize: 0, oldestMtimeMs: null });
});

test('formatBytes: binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(15 * 1024 * 1024 * 1024), '15 GB');
});

test('oldestYear', () => {
  assert.equal(oldestYear(MS_2019), 2019);
  assert.equal(oldestYear(null), null);
  assert.equal(oldestYear('junk'), null);
});

test('summarizeStats: full sentence', () => {
  const s = aggregateStats([
    { size: 14.2 * 1024 * 1024 * 1024, mtimeMs: MS_2019 },
    { size: 0, mtimeMs: MS_2023 },
  ]);
  const line = summarizeStats(s, 'file');
  assert.match(line, /^2 files, /);
  assert.match(line, /GB/);
  assert.match(line, /oldest 2019$/);
});

test('summarizeStats: singular noun + omits empty clauses', () => {
  // One row, no size, no mtime → just the count clause.
  const s = aggregateStats([{}]);
  assert.equal(summarizeStats(s, 'item'), '1 item');
});
