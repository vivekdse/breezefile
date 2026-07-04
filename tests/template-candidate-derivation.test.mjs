// task-2150d862a3d9 — "+ New from Template" showed "no template" even when
// the user had tasks with input/output fields ("Check news" data_keys:
// ['source'], "Get second headline" output_schema:[headline]).
//
// ROOT CAUSE: TaskComposer.tsx's templateCandidates derived candidates from
// LIST-scope rows (useTasks' allTasksForChainCopy), but GET /chromeext/tasks
// ?titles=1 is titles-only — it carries no decrypted body (`notes`, where a
// chain's ```task-template block lives) and no server field schema
// (`dataKeys`/`outputSchema`). So EVERY single-fielded candidate always hit
// `inputKeys.length===0 && outputs.length===0 → skip`, and every chain
// candidate's `parseTaskTemplateBlock(t.notes)` always saw `notes: null` — the
// picker was structurally always empty, regardless of how many fielded tasks
// existed.
//
// FIX: extracted the candidate-derivation into a pure, reusable function
// (deriveTemplateEntry, src/components/newhome/taskSchema.mjs) that accepts
// an optional resolved DETAIL alongside the list row, and prefers the
// detail's notes/dataKeys/outputSchema when present. TaskComposer.tsx now
// pairs this with a bounded, cached detail-fetch resolver (mirroring
// useChainedRoster's pattern) so candidates populate lazily, without
// requiring a server change to add these fields to the list endpoint.
//
// These tests reconstruct the exact bug and its fix: a fielded list row with
// NO detail yields no candidate (proving the list row alone is insufficient —
// this is what silently broke the picker); the SAME row plus its resolved
// detail yields a real candidate (proving the fix works once detail lands).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTemplateEntry } from '../src/components/newhome/taskSchema.mjs';

function listRow(overrides) {
  return {
    id: 'task-list-row',
    title: 'Untitled',
    updated_at: 1000,
    projectId: null,
    // A LIST row never carries these (mapListRow/ListRow, electron/sources/
    // typebuild.ts) — omitted here to mirror the real wire shape exactly.
    ...overrides,
  };
}

test('deriveTemplateEntry: a fielded task with ONLY the list row (no detail resolved yet) yields NO candidate — the regression', () => {
  // "Check news" — data_keys:['source']. Its LIST row carries no dataKeys.
  const checkNews = listRow({ id: 'task-check-news', title: 'Check news' });
  assert.equal(deriveTemplateEntry(checkNews, null), null);

  // "Get second headline" — output_schema:[headline]. Its LIST row carries no
  // outputSchema either.
  const headline = listRow({ id: 'task-headline', title: 'Get second headline' });
  assert.equal(deriveTemplateEntry(headline, undefined), null);
});

test('deriveTemplateEntry: same fielded task, detail resolved → a real "single" candidate with reconstructed defs', () => {
  const checkNews = listRow({ id: 'task-check-news', title: 'Check news', updated_at: 2000 });
  const detail = { dataKeys: ['source'], outputSchema: undefined, notes: null };
  const entry = deriveTemplateEntry(checkNews, detail);
  assert.ok(entry);
  assert.equal(entry.kind, 'single');
  assert.equal(entry.taskId, 'task-check-news');
  assert.equal(entry.name, 'Check news');
  assert.equal(entry.updatedAt, 2000);
  assert.equal(entry.defs.length, 1);
  assert.deepEqual(entry.defs[0].inputs, [{ key: 'source', label: 'source', type: 'text' }]);
  assert.deepEqual(entry.defs[0].outputs, []);
});

test('deriveTemplateEntry: an output-schema-only fielded task (no inputs) also yields a candidate', () => {
  const headline = listRow({ id: 'task-headline', title: 'Get second headline', updated_at: 3000 });
  const outputSchema = [{ key: 'headline', label: 'Headline', type: 'text' }];
  const entry = deriveTemplateEntry(headline, { dataKeys: undefined, outputSchema, notes: null });
  assert.ok(entry);
  assert.equal(entry.kind, 'single');
  assert.deepEqual(entry.defs[0].inputs, []);
  assert.deepEqual(entry.defs[0].outputs, outputSchema);
});

test('deriveTemplateEntry: a chain task — notes only on the detail, absent on the list row — resolves via the detail', () => {
  const chainRow = listRow({ id: 'task-chain', title: 'Untitled', updated_at: 4000 });
  const chainNotes = JSON.stringify({
    v: 2,
    name: 'Morning roundup',
    defs: [{ id: 'step1', name: 'Fetch', inputs: [], outputs: [] }],
  });
  const fenced = '```task-template\n' + chainNotes + '\n```';
  const entry = deriveTemplateEntry(chainRow, { notes: fenced });
  assert.ok(entry);
  assert.equal(entry.kind, 'chain');
  assert.equal(entry.name, 'Morning roundup');
  assert.equal(entry.defs.length, 1);
});

test('deriveTemplateEntry: a genuinely plain task (no fields anywhere) yields no candidate even with detail resolved', () => {
  const plain = listRow({ id: 'task-plain', title: 'Just a note' });
  assert.equal(deriveTemplateEntry(plain, { notes: 'no fenced block here', dataKeys: [], outputSchema: [] }), null);
});

test('deriveTemplateEntry: forward-compat — if a future list endpoint DOES carry dataKeys/outputSchema directly on the row, no detail is required', () => {
  const row = listRow({ id: 'task-future', title: 'Future list row', dataKeys: ['source'] });
  const entry = deriveTemplateEntry(row, null);
  assert.ok(entry);
  assert.equal(entry.kind, 'single');
  assert.deepEqual(entry.defs[0].inputs, [{ key: 'source', label: 'source', type: 'text' }]);
});
