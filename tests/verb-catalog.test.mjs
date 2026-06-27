// fm-m7q / task-1bf3ce50575a — unit tests for the build-safe verb metadata
// module (src/verbCatalog.mjs). No React; runs under `node --test`.
//
// Guards the single-source-of-truth contract: the catalog is well-formed, every
// catalog verb id is a real verb declared in ChipPrompt.tsx's Verb union, the
// keybinding→accelerator conversion honours the single-chord rule, and the
// menu-grouping helper is internally consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  VERB_CATALOG,
  CATEGORY_ORDER,
  VERB_KEYBINDINGS,
  VERB_CATEGORIES,
  keybindingToAccelerator,
  menuAcceleratorFor,
  menuVerbsByCategory,
  helpRowsForCategories,
} from '../src/verbCatalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('every catalog entry has a non-empty id and label', () => {
  for (const v of VERB_CATALOG) {
    assert.ok(typeof v.id === 'string' && v.id.length > 0, `bad id: ${JSON.stringify(v)}`);
    assert.ok(typeof v.label === 'string' && v.label.length > 0, `bad label for ${v.id}`);
  }
});

test('catalog ids are unique', () => {
  const ids = VERB_CATALOG.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate verb id in VERB_CATALOG');
});

test('every category is one of the known buckets', () => {
  for (const v of VERB_CATALOG) {
    if (v.category === undefined) continue;
    assert.ok(
      CATEGORY_ORDER.includes(v.category),
      `verb ${v.id} has unknown category ${v.category}`,
    );
  }
});

test('VERB_KEYBINDINGS / VERB_CATEGORIES are derived from the catalog', () => {
  for (const v of VERB_CATALOG) {
    if (v.keybinding !== undefined) assert.equal(VERB_KEYBINDINGS[v.id], v.keybinding);
    if (v.category !== undefined) assert.equal(VERB_CATEGORIES[v.id], v.category);
  }
});

test('keybindingToAccelerator maps modifier glyphs to Electron syntax', () => {
  assert.equal(keybindingToAccelerator('⌘F'), 'CmdOrCtrl+F');
  assert.equal(keybindingToAccelerator('⌘⇧.'), 'CmdOrCtrl+Shift+.');
  assert.equal(keybindingToAccelerator('⌘⇧T'), 'CmdOrCtrl+Shift+T');
  assert.equal(keybindingToAccelerator('F2'), 'F2');
});

test('keybindingToAccelerator drops multi-chord / unrepresentable bindings', () => {
  assert.equal(keybindingToAccelerator(undefined), undefined);
  assert.equal(keybindingToAccelerator(''), undefined);
  assert.equal(keybindingToAccelerator('gg'), undefined); // multi-key chord
  assert.equal(keybindingToAccelerator('g h'), undefined); // spaced chord
});

test('menuAcceleratorFor prefers an explicit accelerator override', () => {
  // help: palette glyph '?' but the menu shows F1.
  const help = VERB_CATALOG.find((v) => v.id === 'help');
  assert.ok(help);
  assert.equal(help.keybinding, '?');
  assert.equal(help.accelerator, 'F1');
  assert.equal(menuAcceleratorFor(help), 'F1');
});

test('menuVerbsByCategory groups in CATEGORY_ORDER and excludes inMenu:false', () => {
  const groups = menuVerbsByCategory();
  const order = groups.map((g) => g.category);
  // The emitted order must be a subsequence of CATEGORY_ORDER.
  let last = -1;
  for (const cat of order) {
    const idx = CATEGORY_ORDER.indexOf(cat);
    assert.ok(idx > last, `category ${cat} out of order`);
    last = idx;
  }
  // No inMenu:false verb may appear in any group.
  const inMenuFalse = new Set(VERB_CATALOG.filter((v) => v.inMenu === false).map((v) => v.id));
  for (const g of groups) {
    for (const item of g.items) {
      assert.ok(!inMenuFalse.has(item.id), `${item.id} should be excluded from the menu`);
      assert.equal(item.category, g.category);
    }
  }
});

test('menuVerbsByCategory surfaces at least the six core menu sections', () => {
  const cats = new Set(menuVerbsByCategory().map((g) => g.category));
  for (const c of ['Files', 'Selection', 'Navigate', 'View', 'Tools', 'Help']) {
    assert.ok(cats.has(c), `menu is missing the ${c} section`);
  }
});

// Cross-check: every catalog id is a real verb declared in ChipPrompt.tsx. We
// read the source text (importing it would pull in React) and confirm each id
// appears as an `id: '<id>'` verb literal OR `'<id>' as Verb` cast.
test('every catalog verb id exists as a verb in ChipPrompt.tsx', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ChipPrompt.tsx'),
    'utf8',
  );
  const declared = new Set();
  for (const m of src.matchAll(/id:\s*'([^']+)'/g)) declared.add(m[1]);
  for (const m of src.matchAll(/'([^']+)'\s+as\s+Verb/g)) declared.add(m[1]);
  for (const v of VERB_CATALOG) {
    assert.ok(declared.has(v.id), `catalog verb '${v.id}' is not declared in ChipPrompt.tsx`);
  }
});

// ── HelpTour derivation (task-b79d10308ffd) ─────────────────────────────────

test('helpRowsForCategories derives uncovered verbs and skips covered ones', () => {
  const rows = helpRowsForCategories(['Navigate'], ['back', 'forward', 'up', 'goto']);
  const names = rows.map((r) => r.name);
  // Covered ids must NOT appear...
  assert.ok(!names.includes('Back'));
  assert.ok(!names.includes('Go to / Find'));
  // ...while the remaining Navigate verbs do, carrying label + help text.
  assert.ok(names.includes('Unpin from sidebar'));
  const newTab = rows.find((r) => r.name === 'New tab');
  assert.ok(newTab);
  assert.equal(newTab.chord, '⌘T');
  assert.ok(newTab.what.length > 0);
});

// Coverage guarantee: every file-management catalog verb (Selection / Files /
// View / Navigate / Tools) is present in HelpTour — either curated (in a slide's
// `covers`) or in a derived category — so no verb is dropped and a newly added
// verb auto-surfaces. We read HelpTour.tsx as text (importing pulls in React).
test('every file-management catalog verb is reachable in HelpTour.tsx', () => {
  const help = readFileSync(
    join(__dirname, '..', 'src', 'components', 'HelpTour.tsx'),
    'utf8',
  );
  const covers = new Set();
  for (const block of help.matchAll(/covers:\s*\[([\s\S]*?)\]/g)) {
    for (const id of block[1].matchAll(/'([^']+)'/g)) covers.add(id[1]);
  }
  const deriveCats = new Set();
  for (const block of help.matchAll(/categories:\s*\[([^\]]*)\]/g)) {
    for (const c of block[1].matchAll(/'([^']+)'/g)) deriveCats.add(c[1]);
  }
  const fileMgmt = new Set(['Selection', 'Files', 'View', 'Navigate', 'Tools']);
  for (const v of VERB_CATALOG) {
    if (!v.category || !fileMgmt.has(v.category)) continue;
    const reachable = covers.has(v.id) || deriveCats.has(v.category);
    assert.ok(reachable, `verb '${v.id}' (${v.category}) is not reachable in HelpTour`);
  }
});
