// fm-2ln / fm-5rk — unit tests for the pure tagCompose.mjs LLM-frontend layer.
// Runs under `node --test tests/` with no Electron and NO network: we test the
// prompt-building, metadata shaping, and response validation — never the LLM
// round-trip (that lives in electron/llm.ts, main process).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeRow,
  shapeRows,
  buildComposePrompt,
  parseLlmResponse,
  slugifyName,
  pickColor,
  METADATA_FIELDS,
  COMPOSE_MODELS,
  _internal,
} from '../src/tagCompose.mjs';

// A palette mirror of TAG_PALETTE (src/tags.ts). tags.ts is TypeScript, which
// `node --test` can't import, so we keep the literal here. pickColor takes the
// palette as an argument precisely so this module stays free of the TS import;
// the renderer passes the real TAG_PALETTE.
const PALETTE = [
  { id: 'crimson', name: 'Crimson', color: '#a3391a' },
  { id: 'amber', name: 'Amber', color: '#c99a3e' },
  { id: 'olive', name: 'Olive', color: '#6c8a5b' },
  { id: 'teal', name: 'Teal', color: '#2f8f7e' },
  { id: 'indigo', name: 'Indigo', color: '#3b6ea5' },
  { id: 'plum', name: 'Plum', color: '#7a3ea1' },
  { id: 'rose', name: 'Rose', color: '#c2547a' },
  { id: 'sand', name: 'Sand', color: '#8a6d3b' },
  { id: 'slate', name: 'Slate', color: '#5a6470' },
];

// ── shapeRow — metadata projection, NO content/path leakage ─────────────────
test('shapeRow projects only the metadata allow-list, never path', () => {
  const out = shapeRow({
    name: 'Shot 1.png',
    path: '/home/u/Pictures/secret-folder/Shot 1.png',
    parent: '/home/u/Pictures/secret-folder',
    kind: 'file',
    ext: '.PNG',
    size: 2048,
    mtimeMs: 1000,
    ctimeMs: 900,
    depth: 3,
    mime: 'image/png',
  });
  assert.equal(out.name, 'Shot 1.png');
  assert.equal(out.ext, 'png'); // normalized: lowercased, no dot
  assert.equal(out.size, 2048);
  assert.equal(out.mtime, 1000);
  assert.equal(out.ctime, 900);
  assert.equal(out.depth, 3);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.is_dir, false);
  // critically: no path / parent fields cross into the model payload
  assert.equal('path' in out, false);
  assert.equal('parent' in out, false);
});

test('shapeRow derives name + ext from path when absent', () => {
  const out = shapeRow({ path: '/a/b/Report.PDF', size: 10, kind: 'file' });
  assert.equal(out.name, 'Report.PDF');
  assert.equal(out.ext, 'pdf');
});

test('shapeRow omits missing fields rather than nulling them', () => {
  const out = shapeRow({ name: 'x' });
  assert.deepEqual(out, { name: 'x' });
});

test('METADATA_FIELDS does not include path or parent (content-shape guard)', () => {
  assert.equal(METADATA_FIELDS.includes('path'), false);
  assert.equal(METADATA_FIELDS.includes('parent'), false);
});

// ── shapeRows — sampling cap ────────────────────────────────────────────────
test('shapeRows caps the sample to the limit', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.txt`, size: i }));
  assert.equal(shapeRows(rows, 50).length, 50);
  assert.equal(shapeRows(rows, 500).length, 200); // limit clamps to length
  assert.equal(shapeRows([], 50).length, 0);
  assert.equal(shapeRows(null).length, 0);
});

// ── buildComposePrompt ──────────────────────────────────────────────────────
test('buildComposePrompt embeds the description + sample and defaults to the cheap model', () => {
  const p = buildComposePrompt('old screenshots', shapeRows([{ name: 'a.png', size: 1 }]));
  assert.equal(p.model, COMPOSE_MODELS.cheap);
  assert.ok(p.system.includes('tagDsl'));
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].role, 'user');
  assert.ok(p.messages[0].content.includes('old screenshots'));
  assert.ok(p.messages[0].content.includes('a.png'));
});

test('buildComposePrompt rejects an empty description', () => {
  assert.throws(() => buildComposePrompt('   '), /empty/);
});

test('buildComposePrompt honors a model override', () => {
  const p = buildComposePrompt('x', [], { model: 'claude-sonnet-4-6' });
  assert.equal(p.model, 'claude-sonnet-4-6');
});

// ── parseLlmResponse — JSON extraction + tagDsl validation ──────────────────
test('parseLlmResponse extracts + validates a clean JSON object', () => {
  const raw = JSON.stringify({
    selector: 'ext in (png, jpg) and mtime < now-180d',
    name: 'Old Screenshots!!',
    color: 'red',
    confidence: 0.82,
  });
  const s = parseLlmResponse(raw, { palette: PALETTE });
  assert.equal(s.selector, 'ext in (png, jpg) and mtime < now-180d');
  assert.equal(s.name, 'old-screenshots'); // slugified
  assert.equal(s.colorHint, 'red');
  assert.equal(s.color, '#a3391a'); // red → crimson
  assert.equal(s.confidence, 0.82);
});

test('parseLlmResponse handles a ```json fenced response with prose around it', () => {
  const raw =
    'Here you go:\n```json\n{"selector": "size > 1GB", "name": "huge", "color": "amber"}\n```\nDone.';
  const s = parseLlmResponse(raw, { palette: PALETTE });
  assert.equal(s.selector, 'size > 1GB');
  assert.equal(s.name, 'huge');
  assert.equal(s.confidence, 0.5); // default when absent
});

test('parseLlmResponse THROWS on an invalid tagDsl selector (the validation gate)', () => {
  const raw = JSON.stringify({ selector: 'ext = = png', name: 'x', color: 'blue' });
  assert.throws(() => parseLlmResponse(raw, { palette: PALETTE }));
});

test('parseLlmResponse throws when no JSON object is present', () => {
  assert.throws(() => parseLlmResponse('sorry, I cannot do that'), /no JSON/);
});

test('parseLlmResponse throws on a missing/empty selector', () => {
  assert.throws(() => parseLlmResponse(JSON.stringify({ name: 'x' })), /no selector/);
});

test('parseLlmResponse clamps confidence into [0,1]', () => {
  const hi = parseLlmResponse(JSON.stringify({ selector: 'is_dir', confidence: 5 }));
  assert.equal(hi.confidence, 1);
  const lo = parseLlmResponse(JSON.stringify({ selector: 'is_dir', confidence: -3 }));
  assert.equal(lo.confidence, 0);
});

// ── slugifyName ─────────────────────────────────────────────────────────────
test('slugifyName produces capped kebab-case', () => {
  assert.equal(slugifyName('Old Screenshots Taking Up Space'), 'old-screenshots-taki');
  assert.equal(slugifyName('  Big   PDFs!! '), 'big-pdfs');
  assert.equal(slugifyName(''), '');
  assert.equal(slugifyName(null), '');
});

// ── pickColor — semantic hint → palette ─────────────────────────────────────
test('pickColor maps semantic hints onto the palette', () => {
  assert.equal(pickColor('red', PALETTE), PALETTE.find((p) => p.id === 'crimson').color);
  assert.equal(pickColor('blue', PALETTE), PALETTE.find((p) => p.id === 'indigo').color);
  assert.equal(pickColor('green', PALETTE), PALETTE.find((p) => p.id === 'olive').color);
  // unknown hint → first palette entry (never undefined for a non-empty palette)
  assert.equal(pickColor('chartreuse', PALETTE), PALETTE[0].color);
  assert.equal(pickColor('red', []), undefined);
});

// ── extractJsonObject (internal) — balanced-brace extraction ────────────────
test('extractJsonObject finds the first balanced object, ignoring braces in strings', () => {
  const txt = 'noise {"selector": "name ~ \\"{x}\\"", "name": "a"} trailing }';
  const obj = JSON.parse(_internal.extractJsonObject(txt));
  assert.equal(obj.selector, 'name ~ "{x}"');
  assert.equal(obj.name, 'a');
});
