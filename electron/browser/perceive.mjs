// Field perception layer for the operator browser CLI (foundation module).
//
// WHY THIS SHAPE. The operator drives one `electron/browser/cli.mjs` SUBPROCESS
// per verb (see run-metrics.mjs's header for the one-process-per-verb model):
// nothing survives in memory between a `fields` call and the `fill`/`click` that
// acts on what it found. So the map from a stable, human-meaningful ref
// (`e35`) to a live element MUST be persisted to disk keyed by run — exactly the
// stateDir()/BREEZE_MEMORY_DIR + runKey() pattern run-metrics.mjs uses — or the
// next process has no idea what `e35` meant.
//
// WHY ARIA REFS, NOT SELECTORS. Playwright's `page.ariaSnapshot({mode:'ai'})`
// returns the JAWS-style MERGED accessibility tree: one flat, indented view of
// the page AND every same-origin/cross-origin iframe inlined, each interactive
// node tagged with a ref like `[ref=e35]` (top frame) or `[ref=f1e3]` (frame 1,
// element 3; nested frames stack the prefix: f1f2e3). `page.locator('aria-ref=e35')`
// re-resolves that ref from the top-level page handle, piercing frames for free.
// This is the accessibility contract an LLM agent should target: role + name,
// not brittle CSS/XPath.
//
// WHY REFS DIE. A ref is a handle into ONE snapshot's tree. Any re-render
// (SPA route change, React reconcile, list reorder) can renumber or drop it —
// the ref outlives nothing but the DOM it was minted from. So resolveByRef()
// verifies the page URL still matches, checks the element is still live, and —
// when it isn't — RE-SNAPSHOTS and tries to recover the element by (role, name,
// framePath) identity before giving up. Every failure path names the next
// command to run, because these messages go straight to an agent's stdout.
//
// NON-PHI ONLY. The persisted map stores refs/roles/names/labels/placeholders
// and the page URL — never a typed-in VALUE, never field contents. Placeholder
// text is a fixed page label (safe); anything the human/agent enters is not and
// never reaches this layer.
//
// Pure Node, no Electron imports (runs inside the standalone verb CLI). Parsing
// is DEFENSIVE: unknown roles and unknown attributes pass through untouched and
// nothing here throws on a malformed line.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import { runKey } from './tools/run-metrics.mjs';

/** Interactive/salient roles a human or agent actually ACTS on — phase 2 builds
 *  the `fields` verb by filtering snapshot nodes through this set. Kept liberal
 *  (menu/option/tab count) so we surface more rather than hide a control the
 *  agent needs; presentational roles (generic, text, img, heading) are excluded. */
export const INTERACTIVE_ROLES = new Set([
  'textbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'radiogroup',
  'button',
  'link',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'select',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
]);

/** Pull the ref token out of a snapshot line, e.g. `[ref=e35]` or `[ref=f1e3]`.
 *  Generic over nested-frame prefixes (f1, f1f2, …) per the verified format. */
const REF_RE = /\[ref=((?:f\d+)*e\d+)\]/;

/** Split a ref into its frame path + validates shape. `e35` → ''; `f1e3` → 'f1';
 *  `f1f2e3` → 'f1f2'. Returns null for a non-conforming token. */
export function framePathOf(ref) {
  const m = /^((?:f\d+)*)e\d+$/.exec(ref || '');
  return m ? m[1] : null;
}

/** Coerce a bracket-attr value: bare `[checked]` → true, `[level=1]` → 1,
 *  `[cursor=pointer]` → 'pointer'. Unknown keys pass through unchanged. */
function coerceAttr(value) {
  if (value === undefined) return true;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** Parse the `[key]` / `[key=value]` brackets on a node line into an attrs
 *  object, skipping the `ref` bracket (that's the ref, not an attribute). */
function parseBracketAttrs(s) {
  const attrs = {};
  const re = /\[([a-zA-Z_][\w-]*)(?:=([^\]]*))?\]/g;
  let m;
  while ((m = re.exec(s))) {
    const key = m[1];
    if (key === 'ref') continue;
    attrs[key] = coerceAttr(m[2]);
  }
  return attrs;
}

/** Parse `role "name"` off the front of a node line's content. Role is the
 *  first token; the optional quoted name has its `\"` escapes unwound. */
function parseRoleName(content) {
  const m = /^(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(content);
  if (!m) return { role: content.trim(), name: null };
  const role = m[1];
  const name = m[2] === undefined ? null : m[2].replace(/\\(.)/g, '$1');
  return { role, name };
}

/**
 * Parse an aria-snapshot text tree into a flat node list.
 *
 * Every line is either:
 *   - a NODE line:  `- <role> ["name"] [attr]… [ref=eN]:`  (trailing `:` ⇒ has kids)
 *   - an ATTR line: `- /placeholder: Enter your user ID.`   (attaches to its node)
 *   - a TEXT line:  `- text: some copy`  or  `- "some copy"` (attaches to nearest
 *                    ref-bearing ancestor as a textContent fragment)
 *
 * Indentation gives the tree; we keep a stack to derive parentRef (nearest
 * ANCESTOR THAT HAS A REF) and depth. Nodes without a ref are tracked for
 * structure but omitted from the returned list.
 *
 * @returns {Array<{ ref, role, name, framePath, depth, attrs, parentRef, textContent }>}
 */
export function parseSnapshot(text) {
  const nodes = [];
  // stack entries mirror structural nesting: { indent, node|null, ref|null }.
  const stack = [];
  const lines = String(text || '').split('\n');

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    const body = raw.slice(indent);
    if (!body.startsWith('- ')) continue; // defensive: not a list item
    const content = body.slice(2);

    // ── ATTR line: `/key: value` (or `/key:`) — belongs to the deepest open node.
    if (content.startsWith('/')) {
      const am = /^\/([^:]+):\s?(.*)$/.exec(content);
      if (am && stack.length) {
        const top = stack[stack.length - 1];
        if (top.node) top.node.attrs[am[1].trim()] = am[2];
      }
      continue;
    }

    // ── TEXT line: `text: …` or a bare quoted `"…"` — attach to nearest ref
    //    ancestor as a textContent fragment (cheap, best-effort).
    let textFrag = null;
    if (content.startsWith('text:')) {
      textFrag = content.slice(5).trim();
    } else if (content.startsWith('"')) {
      const tm = /^"((?:[^"\\]|\\.)*)"\s*:?\s*$/.exec(content);
      if (tm) textFrag = tm[1].replace(/\\(.)/g, '$1');
    }
    if (textFrag !== null) {
      // Attach to the nearest ANCESTOR (shallower indent) that has a ref — a
      // ref-bearing sibling sitting at the same indent is not this text's owner.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].indent < indent && stack[i].node && stack[i].node.ref) {
          stack[i].node.textContent.push(textFrag);
          break;
        }
      }
      continue;
    }

    // ── NODE line. Pop siblings/deeper entries so the stack holds only ancestors.
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const refMatch = REF_RE.exec(content);
    const ref = refMatch ? refMatch[1] : null;
    const { role, name } = parseRoleName(content);
    const attrs = parseBracketAttrs(content);

    // parentRef = nearest ancestor that carries a ref (skip ref-less containers).
    let parentRef = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].ref) {
        parentRef = stack[i].ref;
        break;
      }
    }

    const node = ref
      ? {
          ref,
          role,
          name,
          framePath: framePathOf(ref) || '',
          depth: stack.length,
          attrs,
          parentRef,
          textContent: [],
        }
      : null;
    if (node) nodes.push(node);

    stack.push({ indent, node, ref });
  }

  return nodes;
}

/**
 * Snapshot the page's merged accessibility tree and parse it.
 * @returns {Promise<{ text: string, nodes: Array }>}
 */
export async function snapshotMerged(page) {
  const text = await page.ariaSnapshot({ mode: 'ai' });
  return { text, nodes: parseSnapshot(text) };
}

/** Filter parsed nodes down to the ones worth acting on (see INTERACTIVE_ROLES).
 *  Phase 2's `fields` verb renders exactly these. */
export function refsFromNodes(nodes) {
  return (nodes || []).filter((n) => n && INTERACTIVE_ROLES.has(n.role));
}

// ─── Ref-map persistence (survives across one-verb-per-process invocations) ──

/** Directory holding this run's field-ref map. Same override + layout as
 *  run-metrics.mjs so tests point BREEZE_MEMORY_DIR at a scratch dir and never
 *  touch a real profile. */
function fieldRefsDir() {
  return path.join(
    process.env.BREEZE_MEMORY_DIR || path.join(stateDir(), 'memory'),
    'field-refs',
  );
}

/** This run's map file, keyed by runKey() (task id → pty id → ppid). */
function fieldRefsFile() {
  return path.join(fieldRefsDir(), runKey() + '.json');
}

/** sha1 of the snapshot text — lets resolveByRef() (and receipts) tell whether
 *  the map was minted from the tree the page is currently showing. */
export function snapshotSha1(text) {
  return createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Persist the ref → (role, name, framePath) map for THIS run so a later verb
 * process can resolve a ref the current process never saw.
 *
 * NON-PHI: stores refs/roles/names/framePaths + the page URL only. Never a
 * typed value. Best-effort like the run-metrics scratchpad — a write miss must
 * not fail the run.
 *
 * @param opts.url   the page URL the snapshot was taken on (staleness anchor)
 * @param opts.refs  array of { ref, role, name, framePath } (e.g. refsFromNodes)
 * @param opts.text  optional snapshot text — hashed into snapshotSha1 if given
 */
export function saveRefMap({ url, refs, text } = {}) {
  const map = {
    url: url || '',
    snapshotSha1: text !== undefined ? snapshotSha1(text) : null,
    savedAt: new Date().toISOString(),
    refs: (refs || []).map((r) => ({
      ref: r.ref,
      role: r.role,
      name: r.name ?? null,
      framePath: r.framePath || '',
    })),
  };
  try {
    const f = fieldRefsFile();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(map, null, 2) + '\n');
  } catch {
    /* best-effort scratchpad — never fail the run on a persistence miss */
  }
  return map;
}

/** Load THIS run's ref map, or null when none has been saved yet. Never throws
 *  (callers turn null into the actionable "run: fields" error themselves). */
export function loadRefMap() {
  try {
    return JSON.parse(readFileSync(fieldRefsFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** Does a field map exist for this run? (Cheap check for callers/receipts.) */
export function hasRefMap() {
  return existsSync(fieldRefsFile());
}

/**
 * Resolve a saved ref to a live Playwright Locator for THIS run.
 *
 * Every failure names the next command an agent should run, because the throw
 * message is the agent's tool output. The staleness ladder:
 *   1. no map        → run `fields` first.
 *   2. url changed   → the page moved out from under the map; re-run `fields`.
 *   3. unknown ref   → the map never had this ref; re-run `fields`.
 *   4. ref went dead → RE-SNAPSHOT and try to recover the SAME element by
 *                      (role, name, framePath). Exactly one match ⇒ silently
 *                      remap (return remapped:true so a caller can note it);
 *                      zero or ambiguous ⇒ re-run `fields`.
 *
 * @param page  a resolved Playwright Page
 * @param ref   a ref token from a prior `fields` run (e.g. 'e35', 'f1e3')
 * @param opts.requireFresh  when true (default) verify the URL still matches and
 *              the element is still live (with the remap recovery above); when
 *              false, trust the map and return the locator without re-checking
 *              liveness (still requires the map to exist and know the ref).
 * @returns {Promise<{ locator, ref, remapped: boolean }>}
 */
export async function resolveByRef(page, ref, { requireFresh = true } = {}) {
  const map = loadRefMap();
  if (!map) throw new Error('no field map for this run — run: fields');

  const currentUrl = page.url();
  if (requireFresh && currentUrl !== map.url) {
    throw new Error(
      `page changed since fields ran (was ${map.url}, now ${currentUrl}) — re-run: fields`,
    );
  }

  const entry = (map.refs || []).find((r) => r.ref === ref);
  if (!entry) throw new Error(`unknown ref "${ref}" — re-run: fields`);

  const locator = page.locator('aria-ref=' + ref);
  if (!requireFresh) return { locator, ref, remapped: false };

  // Liveness: a ref is a handle into ONE snapshot's tree; a re-render can drop
  // it even with the URL unchanged. count()===0 means it's gone — try to
  // recover the identical element from a fresh snapshot before surrendering.
  const count = await locator.count();
  if (count > 0) return { locator, ref, remapped: false };

  const { nodes } = await snapshotMerged(page);
  const matches = nodes.filter(
    (n) =>
      n.role === entry.role &&
      (n.name ?? null) === (entry.name ?? null) &&
      (n.framePath || '') === (entry.framePath || ''),
  );
  if (matches.length === 1) {
    const newRef = matches[0].ref;
    return { locator: page.locator('aria-ref=' + newRef), ref: newRef, remapped: true };
  }

  throw new Error(
    `page changed since fields ran (was ${map.url}, now ${currentUrl}) — re-run: fields`,
  );
}
