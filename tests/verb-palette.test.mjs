// fm-m7q — unit tests for the pure command-palette ranking helper
// (src/verbPalette.mjs). No React; runs under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankPaletteVerbs } from '../src/verbPalette.mjs';

const VERBS = [
  { id: 'copy', label: 'Copy', aliases: ['cp', 'duplicate'], category: 'Selection', available: true },
  { id: 'move', label: 'Move', aliases: ['cut', 'mv'], category: 'Selection', available: true },
  { id: 'compress', label: 'Compress', aliases: ['zip', 'archive'], category: 'Files', available: true },
  { id: 'goto', label: 'Go to / Find', aliases: ['find', 'search'], category: 'Navigate', available: true },
  { id: 'paste', label: 'Paste', aliases: ['pp'], category: 'Selection', available: false },
];

test('empty query returns every verb', () => {
  const out = rankPaletteVerbs(VERBS, '');
  assert.equal(out.length, VERBS.length);
});

test('empty query sorts available verbs before unavailable', () => {
  const out = rankPaletteVerbs(VERBS, '');
  const lastAvail = out.findIndex((v) => !v.available);
  // The only unavailable verb (paste) must come last.
  assert.equal(out[out.length - 1].id, 'paste');
  assert.ok(lastAvail === out.length - 1);
});

test('label-prefix matches beat alias-only matches', () => {
  // "c" prefixes Copy + Compress labels; it also appears in move's alias
  // "cut". The two label-prefix verbs must outrank the alias-only one.
  const out = rankPaletteVerbs(VERBS, 'c');
  const ids = out.map((v) => v.id);
  const iCopy = ids.indexOf('copy');
  const iCompress = ids.indexOf('compress');
  const iMove = ids.indexOf('move'); // matches only via alias 'cut'
  assert.ok(iCopy >= 0 && iCompress >= 0 && iMove >= 0);
  assert.ok(iCopy < iMove, 'copy (label prefix) ranks above move (alias)');
  assert.ok(iCompress < iMove, 'compress (label prefix) ranks above move (alias)');
});

test('alias match surfaces a verb whose label does not contain the query', () => {
  // "zip" is only in compress's aliases, not its label.
  const out = rankPaletteVerbs(VERBS, 'zip');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'compress');
});

test('non-matching query yields no rows', () => {
  const out = rankPaletteVerbs(VERBS, 'xyzzy');
  assert.equal(out.length, 0);
});

test('available verbs rank above unavailable ones for the same query', () => {
  const rows = [
    { id: 'a', label: 'Paste here', available: false },
    { id: 'b', label: 'Paste there', available: true },
  ];
  const out = rankPaletteVerbs(rows, 'paste');
  assert.equal(out[0].id, 'b');
  assert.equal(out[1].id, 'a');
});

test('recency boosts a recently-used verb on a tie', () => {
  // Two verbs that match "se" equally by prefix word; recency should break it.
  const rows = [
    { id: 'select', label: 'Select', available: true },
    { id: 'settings', label: 'Settings', available: true },
  ];
  const noRecency = rankPaletteVerbs(rows, 'set');
  assert.equal(noRecency[0].id, 'settings'); // only settings prefixes "set"

  // With "se" both prefix; recency on 'select' should pull it to the top.
  const withRecency = rankPaletteVerbs(rows, 'se', ['select']);
  assert.equal(withRecency[0].id, 'select');
});

test('description-only match is included but ranks low', () => {
  const rows = [
    { id: 'a', label: 'Alpha', description: 'open the foobar drawer', available: true },
    { id: 'b', label: 'foobar', available: true },
  ];
  const out = rankPaletteVerbs(rows, 'foobar');
  // Label match (b) ranks above description-only match (a).
  assert.equal(out[0].id, 'b');
  assert.equal(out[1].id, 'a');
});
