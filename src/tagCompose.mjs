// fm-2ln / fm-5rk — NL → DSL-selector compilation: the PURE prompt-building +
// response-validation layer for the LLM tag frontend.
//
// An LLM turns a natural-language tag description ("old screenshots taking up
// space") into a tagDsl SELECTOR + a suggested kebab-case NAME + a palette
// COLOR. This module owns everything that does NOT touch the network:
//   - shapeRows()        — project full Entry rows down to the read-only
//                          METADATA the model is allowed to see (NO file
//                          content, ever): name, ext, size, dates, mime, depth.
//   - buildComposePrompt — assemble the system + user prompt for NL→selector.
//   - buildRefinePrompt  — (fm-5rk) assemble the prompt that regenerates a
//                          selector from NEGATIVE EXAMPLES (rejected files),
//                          excluding them while preserving intent. Rejected
//                          files REGENERATE THE RULE — they are never stored as
//                          per-tag exceptions (the epic's "no override" rule).
//   - parseLlmResponse   — extract {selector,name,color} from the model's JSON
//                          and VALIDATE the selector through tagDsl parse().
//   - pickColor          — map a semantic hint (cleanup/work/archive…) onto the
//                          shared TAG_PALETTE.
//
// Authored as plain ESM (with a co-located tagCompose.d.mts for the TS app) so
// `node --test tests/` can exercise the prompt-building + validation WITHOUT a
// network call — the LLM round-trip lives in electron/llm.ts (main process).
//
// NON-PHI: file metadata (names/sizes/dates) is local file-manager data, not
// patient PHI — but file CONTENT is never sent. The shaping below is what
// guarantees that: it copies a fixed allow-list of metadata fields and nothing
// else off each row.

import { parse } from './tagDsl.mjs';

// The model IDs are confirmed by the task. Haiku is the cheap first-pass
// compiler; Sonnet is an optional escalation surface for refinement / low
// confidence. Kept here so the renderer and main share one source of truth.
export const COMPOSE_MODELS = {
  cheap: 'claude-haiku-4-5',
  refine: 'claude-sonnet-4-6',
};

// The metadata fields the model is allowed to see, mirroring the tagDsl field
// catalogue (src/tagDsl.mjs FIELDS) MINUS anything content-bearing. This is the
// allow-list — shapeRows copies only these.
export const METADATA_FIELDS = [
  'name',
  'ext',
  'size',
  'mtime',
  'ctime',
  'depth',
  'mime',
  'is_dir',
];

// ── Row shaping ──────────────────────────────────────────────────────────────
// Project a full-metadata Entry row (from fm.walkScope) to the read-only shape
// the LLM sees. We deliberately drop `path` / `parent` (could leak directory
// structure that reads like content/PII) and keep only basename + coarse
// metadata. NO file body is ever read here — these are stat() fields.
function ext(row) {
  if (row.ext != null) return String(row.ext).replace(/^\./, '').toLowerCase();
  const nm =
    row.name ?? (row.path != null ? String(row.path).split('/').pop() : '') ?? '';
  const dot = String(nm).lastIndexOf('.');
  return dot > 0 ? String(nm).slice(dot + 1).toLowerCase() : '';
}

function depthOf(row) {
  if (typeof row.depth === 'number') return row.depth;
  if (row.path != null) {
    const trimmed = String(row.path).replace(/^\/+|\/+$/g, '');
    return trimmed === '' ? 0 : trimmed.split('/').length;
  }
  return undefined;
}

/**
 * Shape one Entry row to the metadata-only projection. Returns a plain object
 * with the allow-listed fields (missing values omitted, not nulled).
 */
export function shapeRow(row) {
  const r = row ?? {};
  const out = {};
  const name = r.name ?? (r.path != null ? String(r.path).split('/').pop() : undefined);
  if (name != null) out.name = String(name);
  const e = ext(r);
  if (e) out.ext = e;
  if (typeof r.size === 'number') out.size = r.size;
  const mtime = r.mtime ?? r.mtimeMs;
  if (mtime != null) out.mtime = Number(mtime);
  const ctime = r.ctime ?? r.ctimeMs;
  if (ctime != null) out.ctime = Number(ctime);
  const d = depthOf(r);
  if (typeof d === 'number') out.depth = d;
  if (r.mime != null) out.mime = String(r.mime);
  const isDir = r.is_dir ?? (r.kind != null ? r.kind === 'dir' : undefined);
  if (typeof isDir === 'boolean') out.is_dir = isDir;
  return out;
}

/**
 * Shape an array of Entry rows. `limit` caps how many rows are forwarded to the
 * model (keeps the prompt small + cheap) — a representative SAMPLE, not the
 * whole tree. Defaults to 60.
 */
export function shapeRows(rows, limit = 60) {
  if (!Array.isArray(rows)) return [];
  const n = Math.max(0, Math.min(limit, rows.length));
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(shapeRow(rows[i]));
  return out;
}

// ── DSL grammar reference (shared across prompts) ───────────────────────────
// A compact, accurate description of the tagDsl the model must emit. Kept in
// sync with src/tagDsl.mjs by hand.
const DSL_REFERENCE = `tagDsl is a boolean predicate language over file metadata.
Combine with: and · or · not · ( ).
Comparisons: = != > < >= <= ~ (regex match) !~ (regex not-match); also \`field in (a, b)\`, \`field between x and y\`, \`field glob "pattern"\`.
Fields: name ext path parent depth size mtime ctime atime birthtime mime is_dir is_symlink is_hidden.
Literals: bare words/strings; sizes like 4MB 1.5GB (binary units); durations in relative dates like now-30d now+2h; ISO dates 2024-01-01; booleans true/false.
Examples:
  ext = pdf and size > 4MB
  ext in (png, jpg, jpeg, heic) and mtime < now-180d
  name ~ "(?i)screenshot" and ext in (png, jpg)
  is_dir = false and size > 1GB`;

const PALETTE_GUIDANCE = `Pick a color hint that matches the tag's INTENT:
  red    → cleanup / danger / things to delete
  blue   → work / active projects
  green  → archive / keep / done
  amber  → large / attention
  plum,teal,rose,sand,slate → neutral categories`;

// ── Prompt builders ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You compile a natural-language file-tag description into a tagDsl selector for a file manager.
You are given ONLY file METADATA (names, extensions, sizes, dates, mime types) — never file contents.
Return a single JSON object and nothing else, with keys:
  "selector": a valid tagDsl predicate string that matches the described files,
  "name": a short kebab-case tag name (lowercase, hyphens, <20 chars),
  "color": one semantic hint from {red, blue, green, amber, plum, teal, rose, sand, slate},
  "confidence": a number 0..1 for how well the selector captures the intent.
Keep the selector as simple as possible while capturing the intent. Prefer ext/size/date predicates over name regex unless the description is clearly name-based.

${DSL_REFERENCE}

${PALETTE_GUIDANCE}`;

/**
 * Build the message payload for the first-pass NL→selector compile.
 * `description` is the user's natural-language text; `sampleRows` are
 * already-shaped metadata rows (call shapeRows first). Returns
 * { model, system, messages } ready to hand to the LLM helper.
 */
export function buildComposePrompt(description, sampleRows = [], opts = {}) {
  const desc = String(description ?? '').trim();
  if (desc === '') throw new Error('buildComposePrompt: description is empty');
  const sample = Array.isArray(sampleRows) ? sampleRows : [];
  const userText =
    `Describe-as-tag request: ${JSON.stringify(desc)}\n\n` +
    `Here is a sample of file metadata from the user's folder (${sample.length} rows; metadata only, no contents):\n` +
    `${JSON.stringify(sample)}\n\n` +
    `Emit the JSON object now.`;
  return {
    model: opts.model || COMPOSE_MODELS.cheap,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  };
}

/**
 * fm-5rk — build the refinement payload. Given the CURRENT selector, the
 * original description, and the NEGATIVE EXAMPLES the user rejected (shaped
 * metadata rows), ask the model for an IMPROVED selector that EXCLUDES those
 * files while still matching everything the user wanted. The rejects are sent
 * as examples to exclude — they are NOT persisted anywhere; the rule itself is
 * regenerated.
 */
export function buildRefinePrompt(selector, rejectedRows = [], opts = {}) {
  const sel = String(selector ?? '').trim();
  if (sel === '') throw new Error('buildRefinePrompt: selector is empty');
  const rejects = Array.isArray(rejectedRows) ? rejectedRows : [];
  if (rejects.length === 0)
    throw new Error('buildRefinePrompt: need at least one rejected example');
  const desc = String(opts.description ?? '').trim();
  const keptCount = typeof opts.keptCount === 'number' ? opts.keptCount : null;
  const userText =
    `The current tagDsl selector is:\n  ${sel}\n\n` +
    (desc ? `It was meant to capture: ${JSON.stringify(desc)}\n\n` : '') +
    `The user reviewed the matches and REJECTED these ${rejects.length} files ` +
    `(metadata only — they should NOT be tagged):\n${JSON.stringify(rejects)}\n\n` +
    (keptCount != null
      ? `They kept ${keptCount} other matches, which must stay matched.\n\n`
      : '') +
    `Produce an IMPROVED selector that excludes the rejected files while still ` +
    `matching the intended ones. Do NOT enumerate file names to ban — find the ` +
    `metadata distinction (extension, size, date, depth, mime) that separates ` +
    `rejected from kept. Return the same JSON object shape as before.`;
  return {
    model: opts.model || COMPOSE_MODELS.refine,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  };
}

// ── Response parsing + validation ────────────────────────────────────────────

// Pull the first balanced JSON object out of a model response that may be
// wrapped in prose or a ```json fence.
function extractJsonObject(text) {
  const s = String(text ?? '');
  // strip a leading ```json / ``` fence if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i += 1) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse + VALIDATE a raw LLM response into a normalized suggestion. Throws if
 * no JSON object is present or the selector doesn't parse as tagDsl — the
 * caller surfaces that as "the model produced an invalid selector, try again".
 *
 * Returns: { selector, name, color, colorHint, confidence }
 *   - selector: the validated tagDsl string
 *   - name:     normalized kebab-case (slugified, capped)
 *   - color:    a hex from TAG_PALETTE chosen via the color hint (uses pickColor;
 *               pass opts.palette = TAG_PALETTE so this stays renderer-free)
 *   - colorHint: the raw semantic hint the model returned
 *   - confidence: number in [0,1] (defaults to 0.5 when absent)
 */
export function parseLlmResponse(rawText, opts = {}) {
  const jsonStr = extractJsonObject(rawText);
  if (!jsonStr) throw new Error('LLM response contained no JSON object');
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    throw new Error('LLM response JSON did not parse');
  }
  const selector = String(obj.selector ?? '').trim();
  if (selector === '') throw new Error('LLM response had no selector');
  // VALIDATE against the real tagDsl grammar — this is the gate that keeps a
  // malformed selector from ever reaching the tag store.
  parse(selector); // throws ParseError on invalid input

  const colorHint = String(obj.color ?? '').trim().toLowerCase();
  const palette = opts.palette;
  const color = palette ? pickColor(colorHint, palette) : undefined;

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    selector,
    name: slugifyName(obj.name),
    color,
    colorHint,
    confidence,
  };
}

// kebab-case a suggested name: lowercase, hyphen-separated, alnum only, capped.
export function slugifyName(raw, max = 20) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s === '') return '';
  return s.length > max ? s.slice(0, max).replace(/-+$/g, '') : s;
}

// Map a semantic color hint onto the shared TAG_PALETTE. `palette` is the
// TAG_PALETTE array (passed in so this module stays free of the TS tags.ts
// import). Falls back to the first palette entry.
const HINT_TO_PALETTE_ID = {
  red: 'crimson',
  crimson: 'crimson',
  amber: 'amber',
  yellow: 'amber',
  orange: 'amber',
  green: 'olive',
  olive: 'olive',
  teal: 'teal',
  cyan: 'teal',
  blue: 'indigo',
  indigo: 'indigo',
  purple: 'plum',
  plum: 'plum',
  violet: 'plum',
  pink: 'rose',
  rose: 'rose',
  brown: 'sand',
  sand: 'sand',
  tan: 'sand',
  gray: 'slate',
  grey: 'slate',
  slate: 'slate',
};

export function pickColor(hint, palette) {
  if (!Array.isArray(palette) || palette.length === 0) return undefined;
  const id = HINT_TO_PALETTE_ID[String(hint ?? '').toLowerCase()];
  if (id) {
    const hit = palette.find((p) => p.id === id);
    if (hit) return hit.color;
  }
  return palette[0].color;
}

// Internals exposed for focused unit testing.
export const _internal = { extractJsonObject, ext, depthOf };
