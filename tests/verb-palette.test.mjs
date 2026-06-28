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

// task-57542e3435af — the Home quick-switcher feeds the same rows the ':' /
// Cmd-K palette builds. Typing "file manager" or "files" must surface the
// Files command via its multi-word aliases (a sibling-verb crash used to
// blank the whole palette; the ranking itself must still pick Files cleanly).
test('multi-word alias prefix surfaces the Files command', () => {
  const rows = [
    {
      id: 'files',
      label: 'Files (file manager)',
      aliases: ['files', 'file manager', 'file browser', 'folders', 'browse', 'open files'],
      description: 'Open the file manager at home',
      available: true,
    },
    { id: 'new-task', label: 'New task', aliases: ['new task', 'add task', 'task'], available: true },
    { id: 'filter', label: 'Filter', aliases: ['grep', 'show only'], available: true },
  ];
  // The full bug-repro queries must rank Files first.
  for (const q of ['file manager', 'files', 'file']) {
    const out = rankPaletteVerbs(rows, q, []).filter((v) => v.available);
    assert.ok(out.length > 0, `"${q}" yields at least one match`);
    assert.equal(out[0].id, 'files', `"${q}" ranks the Files command first`);
  }
  // A bare "f" prefixes several labels (Filter, Files); Files need only be
  // present, not necessarily first.
  const f = rankPaletteVerbs(rows, 'f', []).filter((v) => v.available);
  assert.ok(f.some((v) => v.id === 'files'), '"f" still surfaces the Files command');
});

// task-f8bb12b2bae3 — VERB PARITY between the Home quick-switcher and the file
// manager's ChipPrompt picker. A multi-word query whose words land in DIFFERENT
// fields (label vs alias vs description) must still match here — the previous
// `haystack.includes(q)` (whole-query-as-one-substring) matcher returned NO
// MATCHES for these, which was the reported "maximize window reports no matches"
// class of bug. The picker now tokenizes and requires every token to hit, just
// like ChipPrompt.
test('multi-word query matches when tokens are scattered across fields', () => {
  const rows = [
    {
      id: 'maximize',
      label: 'Maximize window',
      aliases: ['maximize', 'maximise', 'max', 'unmaximize', 'restore', 'window'],
      description: 'Toggle window maximize (works around WM Alt+Space conflicts)',
      available: true,
    },
    {
      id: 'settings',
      label: 'Settings',
      aliases: ['settings', 'preferences', 'prefs', 'config', 'options'],
      description: 'Open the settings dialog (keybinds, terminal, theme)',
      available: true,
    },
    {
      id: 'fullscreen',
      label: 'Fullscreen',
      aliases: ['fullscreen', 'full-screen', 'fs', 'full'],
      description: 'Toggle fullscreen',
      available: true,
    },
  ];
  // Words split across label + alias ("max" alias + "window" label).
  let out = rankPaletteVerbs(rows, 'max window', []).filter((v) => v.available);
  assert.equal(out[0]?.id, 'maximize', '"max window" resolves to maximize');
  // Word only in the description ("keybinds") plus the label word ("settings").
  out = rankPaletteVerbs(rows, 'settings keybinds', []).filter((v) => v.available);
  assert.equal(out[0]?.id, 'settings', '"settings keybinds" resolves to settings');
  // Word in the description ("toggle") plus a label word ("maximize").
  out = rankPaletteVerbs(rows, 'toggle maximize', []).filter((v) => v.available);
  assert.ok(
    out.some((v) => v.id === 'maximize'),
    '"toggle maximize" surfaces maximize',
  );
  // Reversed word order still matches (tokens are order-independent).
  out = rankPaletteVerbs(rows, 'window maximize', []).filter((v) => v.available);
  assert.equal(out[0]?.id, 'maximize', '"window maximize" resolves to maximize');
});

test('single-token ranking is unchanged after tokenization', () => {
  const out = rankPaletteVerbs(VERBS, 'c');
  const ids = out.map((v) => v.id);
  // Same expectation as the earlier label-prefix test: label prefixes beat
  // the alias-only match.
  assert.ok(ids.indexOf('copy') < ids.indexOf('move'));
  assert.ok(ids.indexOf('compress') < ids.indexOf('move'));
});

test('a query token that matches nothing excludes the verb', () => {
  // "maximize" hits, but "spreadsheet" matches no field → no rows.
  const rows = [
    { id: 'maximize', label: 'Maximize window', aliases: ['max', 'window'], available: true },
  ];
  const out = rankPaletteVerbs(rows, 'maximize spreadsheet', []);
  assert.equal(out.length, 0);
});
