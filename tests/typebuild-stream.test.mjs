// task-996487c8c388 — tests for the SSE stream client's parsing/backoff core.
// The transport class (typebuild-stream.ts) holds the connection; its line and
// backoff semantics live in the shared pure module typebuild-stream-parse.mjs,
// which THIS test imports directly — so the tested contract IS the runtime code
// (no mirrored-copy drift). Same split-out pattern as db-key-derive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChangedPoke,
  splitLines,
  backoffDelay,
} from '../electron/sources/typebuild-stream-parse.mjs';

// ─── isChangedPoke: which SSE lines trigger a resync ────────────────────────

test('keep-alive comments and blank lines are NOT pokes', () => {
  assert.equal(isChangedPoke(': keep-alive'), false);
  assert.equal(isChangedPoke(':'), false);
  assert.equal(isChangedPoke(''), false);
});

test('a changed data event IS a poke (with or without a space)', () => {
  assert.equal(isChangedPoke('data: {"type":"changed","at":"2026-07-05T16:00:00Z"}'), true);
  assert.equal(isChangedPoke('data:{"type":"changed"}'), true);
});

test('a non-changed typed event is ignored', () => {
  assert.equal(isChangedPoke('data: {"type":"hello"}'), false);
});

test('a non-JSON data line is still a poke (never drop a real signal)', () => {
  assert.equal(isChangedPoke('data: ping'), true);
});

test('data with no type field is treated as a poke', () => {
  assert.equal(isChangedPoke('data: {"at":"2026-07-05T16:00:00Z"}'), true);
});

test('event:/id:/retry: field lines are not pokes', () => {
  assert.equal(isChangedPoke('event: message'), false);
  assert.equal(isChangedPoke('id: 42'), false);
  assert.equal(isChangedPoke('retry: 5000'), false);
});

// ─── splitLines: frame reassembly across chunks ─────────────────────────────

test('a data event split across two chunks fires exactly one poke', () => {
  let buf = '';
  const pokes = [];
  const onLine = (l) => { if (isChangedPoke(l)) pokes.push(l); };
  buf = splitLines((buf += 'data: {"type":"cha'), onLine);
  assert.equal(pokes.length, 0, 'incomplete line does not fire');
  buf = splitLines((buf += 'nged"}\n'), onLine);
  assert.equal(pokes.length, 1, 'completed line fires once');
  assert.equal(buf, '', 'no leftover tail after a complete line');
});

test('CRLF line endings are stripped', () => {
  let buf = '';
  const pokes = [];
  buf = splitLines((buf += 'data: {"type":"changed"}\r\n'), (l) => {
    if (isChangedPoke(l)) pokes.push(l);
  });
  assert.equal(pokes.length, 1);
});

test('multiple events in one chunk each fire; comment ignored', () => {
  let buf = '';
  const pokes = [];
  buf = splitLines(
    (buf += ': keep-alive\ndata: {"type":"changed"}\ndata: {"type":"changed"}\n'),
    (l) => { if (isChangedPoke(l)) pokes.push(l); },
  );
  assert.equal(pokes.length, 2);
});

test('splitLines returns the partial tail for the next chunk', () => {
  const seen = [];
  const tail = splitLines('a\nb\nc-partial', (l) => seen.push(l));
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(tail, 'c-partial');
});

// ─── backoffDelay: exponential, capped, jittered ────────────────────────────

test('backoff grows exponentially and caps at 30s', () => {
  assert.equal(backoffDelay(0, 1), 1000);
  assert.equal(backoffDelay(1, 1), 2000);
  assert.equal(backoffDelay(2, 1), 4000);
  assert.equal(backoffDelay(5, 1), 30000); // 32000 capped
  assert.equal(backoffDelay(10, 1), 30000);
});

test('backoff jitter stays within 50–100% of base', () => {
  const base = 4000; // attempt 2
  assert.equal(backoffDelay(2, 0), base * 0.5); // 2000
  assert.equal(backoffDelay(2, 1), base); // 4000
  const mid = backoffDelay(2, 0.5);
  assert.ok(mid >= base * 0.5 && mid <= base, 'jitter within bounds');
});
