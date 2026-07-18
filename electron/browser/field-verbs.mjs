// Field perception VERBS (phase 2) — the read-only `page` / `fields` / `field`
// trio the operator agent uses as its "eyes" on a form, built on perceive.mjs.
//
// WHY A SEPARATE MODULE. cli.mjs's dispatchVerb stays thin (one case each that
// delegates here); the classifier + renderers live together where they can
// share the one hard part — deciding a control's SPECIES — without cli.mjs
// growing a second personality. Pure Node, no Electron imports (runs inside the
// standalone verb CLI subprocess), same as perceive.mjs.
//
// THE CLASSIFIER IS EMPIRICAL, NEVER A GUESS. The a11y tree reports a native
// <select> as role=combobox exactly like a custom ARIA combobox, so snapshot
// role ALONE cannot tell them apart — we read tagName + attributes off the live
// element (locator.evaluate) to settle it. And a static custom combobox looks
// identical to an async autocomplete one until you OPEN it: only `field` probes
// (opens without typing) to refine `combobox` → `combobox-static` (options
// appear) vs `combobox-async` (empty / type-to-search). `fields` never probes
// (it must stay fast) so it reports the unrefined `combobox`.
//
// NON-PHI: renders refs/roles/labels/placeholders + a field's CURRENT value read
// off the page (inputValue/checked). A value read here is the page's own live
// state shown to the agent, never persisted — saveRefMap stores refs only.

import {
  snapshotMerged,
  refsFromNodes,
  saveRefMap,
  resolveByRef,
} from './perceive.mjs';
import { scrubError } from './scrub.mjs';

// ─── Live-element inspection (one evaluate per field) ────────────────────────

/** Read the tagName + the attributes the classifier ladder needs, in ONE
 *  round-trip. Runs in the element's OWN frame (ownerDocument), so an
 *  aria-controls listbox is resolved in the same document even for an iframe
 *  field. Defensive: every attr is best-effort; a missing one is null. */
async function inspect(locator) {
  return locator.evaluate((el) => {
    const g = (a) => el.getAttribute(a);
    const tag = el.tagName;
    const type = (g('type') || '').toLowerCase();
    const isCheck = tag === 'INPUT' && (type === 'checkbox' || type === 'radio');
    // Sensitive fields (passwords, card numbers/CSCs): their value must NEVER
    // leave the page context — it would land verbatim in the agent's transcript.
    // Masked HERE, inside the evaluate, so no caller can read it by accident.
    const ac = (g('autocomplete') || '').toLowerCase();
    const sensitive =
      type === 'password' || /password/.test(ac) || /^cc-(number|csc|exp)/.test(ac);
    const opts =
      tag === 'SELECT'
        ? Array.from(el.options).map((o) => ({
            value: o.value,
            label: (o.textContent || '').trim(),
            selected: o.selected,
          }))
        : null;
    return {
      tag,
      type,
      role: (g('role') || '').toLowerCase(),
      ariaAutocomplete: (g('aria-autocomplete') || '').toLowerCase(),
      ariaControls: g('aria-controls') || null,
      ariaExpanded: g('aria-expanded'),
      nameAttr: g('name') || null,
      required: el.required === true || g('aria-required') === 'true',
      disabled: el.disabled === true || g('aria-disabled') === 'true',
      readOnly: el.readOnly === true || g('aria-readonly') === 'true',
      checked: isCheck ? el.checked : undefined,
      sensitive,
      value:
        'value' in el ? (sensitive ? (el.value ? '«filled»' : '') : el.value) : undefined,
      constraints: {
        maxlength: g('maxlength'),
        minlength: g('minlength'),
        pattern: g('pattern'),
        min: g('min'),
        max: g('max'),
        step: g('step'),
      },
      // full option set for a native select (used by `field`, NOT dumped by
      // `fields`); the collapsed AX tree omits them but the DOM always has them.
      options: opts,
      optionCount: opts ? opts.length : null,
    };
  });
}

/**
 * The classifier ladder (NEVER a guess — see module header). Returns a `kind`
 * plus the raw inspection `d` so callers reuse the single evaluate.
 *
 *   SELECT                                   ⇒ 'select'
 *   INPUT type=date/checkbox/radio           ⇒ those kinds
 *   role=combobox + aria-autocomplete list|both ⇒ 'combobox' (unrefined here;
 *                                               `field` probes it to -static/-async)
 *   INPUT text-ish / TEXTAREA                ⇒ 'text'
 *   BUTTON / role=button                     ⇒ 'button'
 *   link                                     ⇒ 'link'
 *   listbox                                  ⇒ 'listbox'
 *   anything else                            ⇒ 'unknown'
 */
const TEXTISH = new Set(['', 'text', 'tel', 'email', 'number', 'search', 'url', 'password']);

async function classify(locator, snapRole) {
  let d;
  try {
    d = await inspect(locator);
  } catch {
    // element vanished between snapshot and evaluate — fall back to the snapshot
    // role so `fields` still renders a line instead of aborting.
    return { kind: snapRoleToKind(snapRole), d: null };
  }
  let kind;
  if (d.tag === 'SELECT') kind = 'select';
  else if (d.tag === 'INPUT' && d.type === 'date') kind = 'date';
  else if (d.tag === 'INPUT' && d.type === 'checkbox') kind = 'checkbox';
  else if (d.tag === 'INPUT' && d.type === 'radio') kind = 'radio';
  else if (d.role === 'combobox' && (d.ariaAutocomplete === 'list' || d.ariaAutocomplete === 'both'))
    kind = 'combobox';
  else if (d.tag === 'INPUT' && TEXTISH.has(d.type)) kind = 'text';
  else if (d.tag === 'TEXTAREA') kind = 'text';
  else if (d.tag === 'BUTTON' || d.role === 'button' || snapRole === 'button') kind = 'button';
  else if (snapRole === 'link') kind = 'link';
  else if (snapRole === 'listbox' || d.role === 'listbox') kind = 'listbox';
  else kind = snapRoleToKind(snapRole);
  return { kind, d };
}

/** Coarse fallback when we can't evaluate the element (gone / cross-origin):
 *  map the snapshot role to a kind, defaulting to 'unknown'. */
function snapRoleToKind(role) {
  if (role === 'textbox' || role === 'searchbox') return 'text';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'combobox') return 'combobox';
  if (role === 'button') return 'button';
  if (role === 'link') return 'link';
  if (role === 'listbox') return 'listbox';
  return 'unknown';
}

// ─── `fields` — the JAWS Insert+F5 form-field list ───────────────────────────

/** Read a field's current value cheaply for the listing; skip (null) on any
 *  error so one flaky field never blanks the whole list. */
async function currentValue(locator, kind, d) {
  // A sensitive field's value was already masked inside inspect()'s evaluate
  // ('«filled»' / '') — never re-read it through inputValue() and unmask it.
  if (d?.sensitive) return d.value ?? null;
  try {
    if (kind === 'checkbox' || kind === 'radio') {
      return (await locator.isChecked()) ? 'checked' : 'unchecked';
    }
    return await locator.inputValue();
  } catch {
    return null;
  }
}

/** Which kinds are FORM fields (listed first, they're the point) vs which are
 *  navigation (links/buttons, one terse section after). Options/menuitems are
 *  members of a listbox/menu, not standalone fields — excluded from the list. */
const FORM_KINDS = new Set(['select', 'date', 'checkbox', 'radio', 'combobox', 'text', 'listbox']);
const NAV_ROLES = new Set(['button', 'link']);
const SKIP_ROLES = new Set(['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab']);

/** `[frame fN]` marker for a non-top field (framePath 'f1' → ' [frame f1]'). */
function frameMarker(framePath) {
  return framePath ? ` [frame ${framePath}]` : '';
}

/** Compact state-flag suffix, e.g. ` [required]` or ` [disabled checked]`. */
function flagSuffix(d, valueLabel) {
  const flags = [];
  if (d?.required) flags.push('required');
  if (d?.disabled) flags.push('disabled');
  if (d?.readOnly) flags.push('readonly');
  if (d?.checked === true) flags.push('checked');
  if (d?.ariaExpanded === 'true') flags.push('expanded');
  return flags.length ? ` [${flags.join(' ')}]` : '';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Build the `fields` output: one line per form field (ref, kind, label, value,
 * flags, option count, frame marker), then a terse links/buttons section, then
 * the self-describing action line. Persists the ref map (ALL listed refs) so a
 * later `field`/`field-select`/`field-fill` process can resolve them.
 *
 * @returns {Promise<string>} the full text to print
 */
export async function describeFields(page) {
  const { text, nodes } = await snapshotMerged(page);
  const interactive = refsFromNodes(nodes).filter((n) => !SKIP_ROLES.has(n.role));

  // Classify each interactive node (one evaluate apiece). Radios are grouped
  // afterward, so classify them too but hold them aside.
  const classified = [];
  for (const n of interactive) {
    const loc = page.locator('aria-ref=' + n.ref);
    const { kind, d } = await classify(loc, n.role);
    classified.push({ node: n, kind, d, loc });
  }

  const formFields = classified.filter((c) => FORM_KINDS.has(c.kind) && c.kind !== 'radio');
  const radios = classified.filter((c) => c.kind === 'radio');
  const nav = classified.filter((c) => NAV_ROLES.has(c.kind));

  const lines = [];
  const fieldCount = formFields.length + radios.length;
  lines.push(`fields (${fieldCount}):`);

  for (const c of formFields) {
    const val = await currentValue(c.loc, c.kind, c.d);
    const optCount =
      c.d && c.d.optionCount != null ? `  options:${c.d.optionCount}` : '';
    const valStr = val != null && val !== '' ? `  value=${JSON.stringify(val)}` : '';
    lines.push(
      `  ${pad(c.node.ref, 6)} ${pad(c.kind, 9)} ${JSON.stringify(c.node.name ?? '')}` +
        valStr +
        optCount +
        flagSuffix(c.d) +
        frameMarker(c.node.framePath),
    );
  }

  // Radios: group by DOM name attribute into one radiogroup line per group.
  if (radios.length) {
    const groups = new Map();
    for (const c of radios) {
      const key = (c.d && c.d.nameAttr) || c.node.framePath + '::(ungrouped)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [key, members] of groups) {
      const opts = members.map((m) => m.node.name ?? '').filter(Boolean);
      const checked = members.find((m) => m.d && m.d.checked === true);
      const refs = members.map((m) => m.node.ref).join(',');
      lines.push(
        `  ${pad(refs, 6)} ${pad('radiogroup', 9)} ${JSON.stringify(key.replace(/::.*/, ''))}` +
          `  options:[${opts.join(', ')}]` +
          (checked ? `  value=${JSON.stringify(checked.node.name ?? '')}` : '') +
          frameMarker(members[0].node.framePath),
      );
    }
  }

  if (nav.length) {
    lines.push(`links/buttons (${nav.length}):`);
    for (const c of nav) {
      lines.push(
        `  ${pad(c.node.ref, 6)} ${pad(c.kind, 9)} ${JSON.stringify(c.node.name ?? '')}` +
          flagSuffix(c.d) +
          frameMarker(c.node.framePath),
      );
    }
  }

  if (fieldCount === 0 && nav.length === 0) {
    // broken-aria / div-soup: no ARIA field semantics at all. Degrade with an
    // escape hatch instead of pretending the page has no controls.
    lines.push(
      '  (no accessible fields found — the control may be div-soup with no ARIA ' +
        'roles; fall back to: snapshot [selector] or net-observe)',
    );
  }

  // Persist ALL listed refs (form fields + radios + nav) so the next process can
  // resolve them. saveRefMap stores refs/roles/names/framePaths + url only.
  const allRefs = classified.map((c) => c.node);
  saveRefMap({ url: page.url(), refs: allRefs, text });

  lines.push(
    '→ inspect: field <ref> · act: field-select <ref> --pick <label> | field-fill <ref> <value>',
  );
  return lines.join('\n');
}

// ─── `field <ref>` — one field's full contract as JSON ───────────────────────

/** Open a custom combobox WITHOUT typing, harvest options from its
 *  aria-controls listbox, then Escape + blur — SIDE-EFFECT-SAFE (never commits,
 *  never types, so a committed-value readout is unchanged). Options appearing ⇒
 *  static; empty ⇒ async. Returns { options: string[]|null }. */
async function probeCombobox(locator) {
  let options = null;
  try {
    await locator.focus();
    await locator.press('ArrowDown'); // opens both our fixtures' patterns
    // Give a static list a beat to render (async stays empty regardless).
    await locator.page().waitForTimeout(150);
    options = await locator.evaluate((el) => {
      const id = el.getAttribute('aria-controls');
      const lb = id ? el.ownerDocument.getElementById(id) : null;
      if (!lb) return null;
      const opts = Array.from(lb.querySelectorAll('[role="option"]')).map((o) =>
        (o.textContent || '').trim(),
      );
      return opts;
    });
  } catch {
    options = null;
  } finally {
    // Restore: close the popup and drop focus so the page looks untouched.
    try { await locator.press('Escape'); } catch { /* best-effort */ }
    try { await locator.blur(); } catch { /* best-effort */ }
  }
  return { options };
}

/** Trim a constraints bag down to the keys actually present (null/'' dropped). */
function presentConstraints(c) {
  const out = {};
  if (!c) return out;
  for (const k of ['maxlength', 'minlength', 'pattern', 'min', 'max', 'step']) {
    if (c[k] != null && c[k] !== '') out[k] = c[k];
  }
  return out;
}

const OPTION_CAP = 50;

/**
 * Build the `field <ref>` contract JSON. Resolves the ref (resolveByRef
 * re-snapshots + remaps transparently across the process boundary), classifies
 * it, and — per species — fills options/optionsHint/howToSet:
 *   - select        : options inline, capped at OPTION_CAP with total count;
 *                     --filter <substr> narrows the FULL list (no 10k dump).
 *   - combobox      : PROBE to refine → combobox-static (harvest options) or
 *                     combobox-async (options:null + type-to-search hint).
 *   - radio/checkbox/text/date : value + constraints; no option harvest.
 *   - unknown       : still returns JSON (kind 'unknown') + an escape-hatch hint.
 *
 * @param opts.filter  substring to narrow a native select's option list
 * @returns {Promise<string>} pretty JSON
 */
export async function describeField(page, ref, opts = {}) {
  // resolveByRef throws perceive.mjs's own actionable text (no map / url changed
  // / unknown ref / stale) — cli.mjs lets that surface untouched.
  const { locator, ref: liveRef, remapped } = await resolveByRef(page, ref);
  const { kind, d } = await classify(locator);

  const out = {
    ref: liveRef,
    kind,
    label: null,
    value: null,
    required: !!(d && d.required),
    disabled: !!(d && d.disabled),
    constraints: presentConstraints(d && d.constraints),
    options: null,
    optionsHint: null,
    howToSet: null,
  };
  // Cross-process refs are re-derived every time (see perceive.mjs); only note a
  // remap when it actually landed on a DIFFERENT ref, not the same identity.
  if (remapped && liveRef !== ref) out.remappedFrom = ref;

  // Accessible label from a fresh snapshot node (name), best-effort.
  try {
    const { nodes } = await snapshotMerged(page);
    const node = nodes.find((n) => n.ref === liveRef);
    if (node) out.label = node.name ?? null;
  } catch { /* label stays null */ }

  // Current value read off the live element.
  try {
    if (kind === 'checkbox' || kind === 'radio') {
      out.value = (await locator.isChecked()) ? 'checked' : 'unchecked';
    } else if (d && d.value !== undefined) {
      out.value = d.value;
    } else {
      out.value = await locator.inputValue();
    }
  } catch { /* value stays null */ }

  if (kind === 'select') {
    const all = (d && d.options) || [];
    const filter = typeof opts.filter === 'string' ? opts.filter.toLowerCase() : null;
    const matched = filter
      ? all.filter((o) => o.label.toLowerCase().includes(filter))
      : all;
    out.options = matched.slice(0, OPTION_CAP).map((o) => o.label);
    if (matched.length > OPTION_CAP) {
      out.optionsHint =
        `showing ${OPTION_CAP} of ${matched.length}` +
        (filter ? ` matching "${opts.filter}"` : '') +
        ` — narrow with: field ${liveRef} --filter <substr>`;
    } else if (filter) {
      out.optionsHint = `${matched.length} of ${all.length} match "${opts.filter}"`;
    }
    out.howToSet =
      all.length > OPTION_CAP
        ? `field-select ${liveRef} --query <substr> --pick <label>`
        : `field-select ${liveRef} --pick <label>`;
  } else if (kind === 'combobox') {
    // Refine EMPIRICALLY: open (no typing), see whether options appear.
    const { options } = await probeCombobox(locator);
    if (options && options.length) {
      out.kind = 'combobox-static';
      out.options = options.slice(0, OPTION_CAP);
      if (options.length > OPTION_CAP) {
        out.optionsHint = `showing ${OPTION_CAP} of ${options.length}`;
      }
      out.howToSet = `field-select ${liveRef} --pick <label>`;
    } else {
      out.kind = 'combobox-async';
      out.options = null;
      out.optionsHint =
        'async — options come from typing; use field-select ' +
        `${liveRef} --query <text> --pick <label>`;
      out.howToSet = `field-select ${liveRef} --query <text> --pick <label>`;
    }
  } else if (kind === 'checkbox') {
    out.howToSet = `field-select ${liveRef} --pick <checked|unchecked>`;
  } else if (kind === 'radio') {
    out.howToSet = `field-select ${liveRef} --pick <label>`;
  } else if (kind === 'text' || kind === 'date') {
    out.howToSet = `field-fill ${liveRef} <value>`;
  } else if (kind === 'listbox') {
    out.howToSet = `field-select ${liveRef} --pick <label>`;
  } else {
    // unknown — never a bare error; print the JSON with an escape hatch.
    out.optionsHint =
      `unclassifiable — fall back to: snapshot [selector] or net-observe`;
  }

  return JSON.stringify(out, null, 2);
}

// ─── `page` — one-screen orientation skeleton (a few hundred bytes) ──────────

const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'search',
  'form',
]);

/**
 * Compact orientation: title, URL, landmarks, headings (with level), frame
 * count + titles, and counts of interactive fields/links/buttons. NO full tree
 * dump — a few hundred bytes so the agent orients without paying for the whole
 * a11y tree.
 *
 * @returns {Promise<string>}
 */
export async function describePage(page) {
  const [title, { nodes }] = await Promise.all([
    page.title().catch(() => ''),
    snapshotMerged(page),
  ]);

  const landmarks = [];
  const headings = [];
  const frameNodes = [];
  for (const n of nodes) {
    if (LANDMARK_ROLES.has(n.role)) {
      landmarks.push(n.name ? `${n.role} "${n.name}"` : n.role);
    } else if (n.role === 'heading') {
      const lvl = n.attrs && n.attrs.level != null ? n.attrs.level : '?';
      headings.push(`h${lvl} ${JSON.stringify(n.name ?? '')}`);
    } else if (n.role === 'iframe') {
      frameNodes.push(n);
    }
  }
  // The mode:ai snapshot doesn't expose an iframe's title as its accessible name,
  // so read the `title` attribute (falling back to the framed document's title)
  // off each iframe element — a handful of frames, best-effort.
  const frames = [];
  for (const n of frameNodes) {
    let title = n.name || '';
    if (!title) {
      try {
        title = await page.locator('aria-ref=' + n.ref).evaluate((el) => {
          const t = el.getAttribute('title');
          if (t) return t;
          try { return (el.contentDocument && el.contentDocument.title) || ''; } catch { return ''; }
        });
      } catch { /* frame gone / cross-origin — leave untitled */ }
    }
    frames.push(title || '(untitled)');
  }

  // Interactive tallies from the same snapshot (no extra round-trip).
  const interactive = refsFromNodes(nodes);
  let fieldN = 0;
  let linkN = 0;
  let buttonN = 0;
  for (const n of interactive) {
    if (n.role === 'link') linkN++;
    else if (n.role === 'button') buttonN++;
    else if (['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'searchbox',
      'slider', 'spinbutton', 'switch', 'select', 'date'].includes(n.role))
      fieldN++;
  }

  const lines = [];
  lines.push(`title: ${title}`);
  lines.push(`url: ${page.url()}`);
  if (landmarks.length) lines.push(`landmarks: ${landmarks.join(', ')}`);
  if (headings.length) {
    const shown = headings.slice(0, 12);
    lines.push(`headings: ${shown.join(' · ')}` + (headings.length > 12 ? ` … (+${headings.length - 12})` : ''));
  }
  if (frames.length) lines.push(`frames (${frames.length}): ${frames.join(', ')}`);
  lines.push(`interactive: ${fieldN} fields, ${linkN} links, ${buttonN} buttons`);
  lines.push('→ list form fields: fields · inspect one: field <ref>');
  return lines.join('\n');
}

// ═══ PHASE 3 — the ref-based ACTION verbs (field-fill / field-select) ═════════
//
// These COMMIT a value: they take a ref minted by `fields`, resolve it across
// the process boundary (resolveByRef — remap is the normal cross-process path),
// and set it. Everything the setters need beyond phase 2 lives here so cli.mjs's
// dispatchVerb stays thin. Two hard invariants carry over from phase 2:
//   - PHI never crosses argv/stdout. A --data-ref / --query-ref value is resolved
//     inside this process (via the resolveDataRef callback cli.mjs injects) and is
//     never printed; a sensitive target's read-back is masked to «filled»; a
//     Playwright failure on the value-bearing step is scrubbed before it surfaces.
//   - NEVER GUESS. An ambiguous / no-match --pick prints the nearest candidates
//     and a retry line and exits 1 — it does not pick "closest" and commit.
//
// The setters return a plain { text, code } (code 0 ok, 1 caller sets exitCode)
// rather than throwing for the ambiguity/refusal/timeout paths, because the CLI's
// timeVerb wrapper must still print its [timing] line and the message must land on
// STDOUT (the agent reads tool stdout) — exactly how phase 2's stale-ref path
// behaves. resolveByRef's own throws (no map / stale / unknown ref) still bubble
// to cli.mjs, which prints them on stdout + exitCode 1, unchanged.

/** Accessible label for a resolved ref (fresh snapshot node name), best-effort;
 *  falls back to the ref token so a receipt always has something to name. */
async function labelForRef(page, liveRef) {
  try {
    const { nodes } = await snapshotMerged(page);
    const node = nodes.find((n) => n.ref === liveRef);
    if (node && node.name != null) return node.name;
  } catch { /* fall through to the ref token */ }
  return liveRef;
}

/** Lowercase + collapse whitespace — the normalization rung of the match ladder. */
function normLabel(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * THE MATCH LADDER (shared by every species — see module header's NEVER GUESS).
 * Against the FULL option label list for the field:
 *   1. exact          — label === pick
 *   2. normalized     — normLabel(label) === normLabel(pick)   (case/whitespace)
 *   3. substring      — normLabel(label) includes normLabel(pick)
 * The FIRST rung with exactly one hit wins. Two+ hits at any rung ⇒ ambiguous
 * (never silently take the first). Zero hits through all rungs ⇒ none.
 *
 * @returns {{index:number}|{ambiguous:true}|{none:true}}
 */
function matchPick(pick, labels) {
  const rungs = [
    (l) => l === pick,
    (l) => normLabel(l) === normLabel(pick),
    (l) => normLabel(l).includes(normLabel(pick)),
  ];
  for (const test of rungs) {
    const hits = [];
    for (let i = 0; i < labels.length; i++) if (test(labels[i])) hits.push(i);
    if (hits.length === 1) return { index: hits[0] };
    if (hits.length > 1) return { ambiguous: true };
  }
  return { none: true };
}

/** Score a label for the "nearest candidates" list: exact > prefix > substring >
 *  token overlap. Cheap and good enough — this is a hint, not the match. */
function scoreCandidate(pick, label) {
  const p = normLabel(pick);
  const l = normLabel(label);
  if (!p || !l) return 0;
  if (l === p) return 10000;
  if (l.startsWith(p)) return 5000 - (l.length - p.length);
  if (p.startsWith(l)) return 4500 - (p.length - l.length); // pick over-specified
  if (l.includes(p)) return 3000 - (l.length - p.length);
  if (p.includes(l)) return 2500 - (p.length - l.length);
  // common-prefix length + shared-token count as a tiebreak among the rest.
  let k = 0;
  while (k < p.length && k < l.length && p[k] === l[k]) k++;
  const pt = new Set(p.split(' '));
  let overlap = 0;
  for (const t of l.split(' ')) if (pt.has(t)) overlap++;
  return overlap * 100 + k * 10;
}

/** Up to `n` nearest option labels to `pick`, best first. */
function nearestCandidates(pick, labels, n = 10) {
  return labels
    .map((l) => ({ l, s: scoreCandidate(pick, l) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.l);
}

/** Build the ambiguity/no-match candidate block (STDOUT, exit 1). Prints up to
 *  10 nearest options then a copy-pasteable retry line. */
function candidatesText(liveRef, header, pick, labels) {
  const near = nearestCandidates(pick, labels).filter((l) => l != null && l !== '');
  const lines = [header];
  for (const c of near) lines.push(`  ${c}`);
  lines.push(`→ retry: field-select ${liveRef} --pick "${near[0] ?? '<label>'}"`);
  return lines.join('\n');
}

// ─── field-fill <ref> <value…> | field-fill <ref> --data-ref <key> ───────────

/** Read a text/date field's committed value back for the receipt — but a
 *  SENSITIVE field (password/cc-*) is never unmasked: we just filled it, so it's
 *  «filled». Mirrors currentValue()/inspect()'s masking contract. */
async function readBackValue(locator, d) {
  if (d && d.sensitive) return '«filled»';
  try {
    return await locator.inputValue();
  } catch {
    return '';
  }
}

/** Kinds field-fill refuses (they commit via SELECTION, not free text) → the
 *  receipt points at the right verb rather than typing into the wrong control. */
const NOT_FILLABLE = new Set([
  'select',
  'combobox',
  'combobox-static',
  'combobox-async',
  'listbox',
  'checkbox',
  'radio',
]);

/**
 * field-fill: set a text/date field by ref.
 *   - plain value : locator.fill(value) → read back → `filled "<label>" = "<v>"`
 *                   (+ ` [remapped]` when resolveByRef remapped the ref).
 *   - --data-ref  : value resolved via the injected resolveDataRef callback,
 *                   never touching argv/stdout; receipt names the ref + length
 *                   only: `filled "<label>" (data-ref <key>, N chars)`. A
 *                   Playwright failure on the fill is scrubbed of the value.
 *
 * @param opts.value          literal value (plain path)
 * @param opts.dataRef        placeholder key (PHI path) — mutually exclusive
 * @param opts.resolveDataRef async (key)=>value, injected by cli.mjs (PHI stays
 *                            in-process; never imported here to avoid a cycle)
 * @returns {Promise<{text:string, code:number}>}
 */
export async function fillField(page, ref, { value, dataRef, resolveDataRef } = {}) {
  const { locator, ref: liveRef, remapped } = await resolveByRef(page, ref);
  const { kind, d } = await classify(locator);
  const label = await labelForRef(page, liveRef);
  const remap = remapped && liveRef !== ref ? ' [remapped]' : '';

  if (NOT_FILLABLE.has(kind)) {
    return {
      text: `"${label}" is ${kind} — use field-select ${liveRef} --pick <label>`,
      code: 1,
    };
  }

  if (dataRef) {
    // PHI path: resolve inside this process; the value never enters argv/stdout.
    const v = await resolveDataRef(dataRef);
    try {
      await locator.fill(v);
    } catch (e) {
      // A fill failure ("Call log:" interpolates the typed value) is scrubbed.
      return { text: `could not fill "${label}" (data-ref ${dataRef}): ${scrubError(e, v)}`, code: 1 };
    }
    // Receipt names the ref + char count ONLY — never the value, never a read-back.
    return {
      text: `filled "${label}" (data-ref ${dataRef}, ${v.length} chars)${remap}`,
      code: 0,
    };
  }

  await locator.fill(String(value ?? ''));
  const committed = await readBackValue(locator, d);
  return { text: `filled "${label}" = "${committed}"${remap}`, code: 0 };
}

// ─── field-select <ref> --pick <label> [--query <text> | --query-ref <key>] ──

/** Open a custom combobox to render its options WITHOUT typing (static list):
 *  focus fires the fixture/portal's open, ArrowDown is the belt-and-braces open
 *  for patterns that need a key. Left OPEN (unlike probeCombobox) so we can act. */
async function openCombo(locator) {
  try {
    await locator.focus();
    await locator.press('ArrowDown');
    await locator.page().waitForTimeout(120);
  } catch { /* best-effort — harvest will report an empty list if it didn't open */ }
}

/** Harvest the visible option labels from a combobox's aria-controls listbox,
 *  in DOM order (so an index lines up with a later click-by-index). */
async function harvestOptions(locator) {
  try {
    return await locator.evaluate((el) => {
      const id = el.getAttribute('aria-controls');
      const lb = id ? el.ownerDocument.getElementById(id) : null;
      if (!lb) return null;
      return Array.from(lb.querySelectorAll('[role="option"]')).map((o) =>
        (o.textContent || '').trim(),
      );
    });
  } catch {
    return null;
  }
}

/** Commit a combobox option by its DOM index by dispatching a bubbling mousedown
 *  (the event ARIA comboboxes/React-Select commit on — chosen over Playwright
 *  .click() because commit detaches the <li> mid-gesture, which trips a real
 *  click's mouseup). mouseup/click follow best-effort. Returns whether the option
 *  existed. */
async function clickOptionByIndex(locator, index) {
  try {
    return await locator.evaluate((el, idx) => {
      const id = el.getAttribute('aria-controls');
      const lb = id ? el.ownerDocument.getElementById(id) : null;
      if (!lb) return false;
      const opts = Array.from(lb.querySelectorAll('[role="option"]'));
      const target = opts[idx];
      if (!target) return false;
      try { target.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      const view = el.ownerDocument.defaultView;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        try {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view }));
        } catch { /* the first (mousedown) is the one that commits; rest advisory */ }
      }
      return true;
    }, index);
  } catch {
    return false;
  }
}

/**
 * ARROW-THROUGH FALLBACK / virtualized PRIMARY. Walk aria-activedescendant to a
 * target label entirely IN-PAGE (one round-trip): dispatch bubbling ArrowDown
 * keydowns, reading the active option's text each step, up to maxSteps; on a
 * match, dispatch Enter. This is how a windowed listbox (only ~10 of 1000 options
 * in the DOM at once) is selectable — you cannot scrape a full list, so you drive
 * the widget's own keyboard contract and read where it lands.
 *
 * NOTE: dispatched KeyboardEvents (not real CDP key input) — necessary to keep a
 * 720-step walk to one round-trip; fixtures + React-style delegated keydown
 * handlers respond to them. Match is exact-or-normalized (a substring rung while
 * walking could stop early on the wrong row).
 *
 * @returns {Promise<{committed:string|null, steps:number, last:string|null}>}
 */
async function walkToLabel(locator, targetLabel, maxSteps) {
  try {
    return await locator.evaluate(
      (el, args) => {
        const { target, maxSteps } = args;
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const nt = norm(target);
        const doc = el.ownerDocument;
        const activeText = () => {
          const id = el.getAttribute('aria-activedescendant');
          const n = id ? doc.getElementById(id) : null;
          return n ? (n.textContent || '').trim() : null;
        };
        const fire = (key) =>
          el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        const isMatch = (t) => t != null && (t === target || norm(t) === nt);
        try { el.focus(); } catch { /* ignore */ }
        let cur = activeText();
        if (isMatch(cur)) { fire('Enter'); return { committed: cur, steps: 0, last: cur }; }
        for (let i = 0; i < maxSteps; i++) {
          fire('ArrowDown');
          cur = activeText();
          if (isMatch(cur)) { fire('Enter'); return { committed: cur, steps: i + 1, last: cur }; }
        }
        return { committed: null, steps: maxSteps, last: cur };
      },
      { target: targetLabel, maxSteps },
    );
  } catch {
    return { committed: null, steps: 0, last: null };
  }
}

const ASYNC_TIMEOUT_MS = 8000;
const WALK_MAX_STEPS = 1500;

/**
 * Type a query into an async combobox (per-key ~40ms so debounced fixtures/portals
 * fire) and SETTLE. Primary settle signal: a role=status live region reads the
 * ARIA-authoring-practices "N results available." string; fallback: the listbox's
 * option child count goes non-zero. Hard 8s timeout.
 *
 * @returns {Promise<{settled:boolean, optCount:number, statusText:string|null,
 *                    timedOut:boolean}>}
 */
async function typeQueryAndSettle(locator, query) {
  try { await locator.focus(); } catch { /* ignore */ }
  try { await locator.fill(''); } catch { /* ignore — start from a clean field */ }
  await locator.pressSequentially(query, { delay: 40 });

  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  for (;;) {
    const st = await locator.evaluate((el) => {
      const doc = el.ownerDocument;
      const id = el.getAttribute('aria-controls');
      const lb = id ? doc.getElementById(id) : null;
      const optCount = lb ? lb.querySelectorAll('[role="option"]').length : 0;
      let statusText = null;
      for (const s of doc.querySelectorAll('[role="status"]')) {
        const t = (s.textContent || '').trim();
        if (t) statusText = t; // last non-empty status region wins
      }
      return { optCount, statusText };
    });
    // PRIMARY: the results-count live region has landed (0 counts too — a settled
    // "0 results available." is a real answer, not a still-loading state).
    if (st.statusText && /\bresults available\b/i.test(st.statusText)) {
      return { settled: true, optCount: st.optCount, statusText: st.statusText, timedOut: false };
    }
    // FALLBACK: options mutated into the listbox even without a status region.
    if (st.optCount > 0) {
      return { settled: true, optCount: st.optCount, statusText: st.statusText, timedOut: false };
    }
    if (Date.now() > deadline) {
      return { settled: false, optCount: st.optCount, statusText: st.statusText, timedOut: true };
    }
    await locator.page().waitForTimeout(100);
  }
}

/** Read a combobox input's committed value (post-commit input.value). */
async function comboValue(locator) {
  try { return await locator.inputValue(); } catch { return null; }
}

/** Commit a matched combobox option (dispatch-click first; arrow-walk+Enter
 *  fallback for a virtualized/detaching list), then verify input.value landed on
 *  the option label. Returns the committed value or null on failure. */
async function commitComboOption(locator, index, optionLabel) {
  await clickOptionByIndex(locator, index);
  let val = await comboValue(locator);
  if (val != null && normLabel(val) === normLabel(optionLabel)) return val;
  // Fallback: walk aria-activedescendant to the option and Enter.
  await walkToLabel(locator, optionLabel, WALK_MAX_STEPS);
  val = await comboValue(locator);
  if (val != null && normLabel(val) === normLabel(optionLabel)) return val;
  return null;
}

/**
 * field-select: commit a choice on a ref, dispatching per SPECIES (see the
 * classifier in this module). Returns { text, code } — code 1 for ambiguity /
 * no-match / refusal / timeout (message already on the returned text; cli.mjs
 * prints it to STDOUT and sets exitCode). resolveByRef's own staleness throws
 * bubble past this to cli.mjs unchanged.
 *
 * @param opts.pick       the option label to select (required)
 * @param opts.query      literal type-to-search text (async; optional for others)
 * @param opts.queryRef   PHI placeholder key for the query (resolved in-process,
 *                        NEVER echoed) — mutually exclusive with query
 * @param opts.resolveDataRef  async (key)=>value, injected by cli.mjs
 */
export async function selectField(page, ref, opts = {}) {
  const { pick } = opts;
  const { locator, ref: liveRef, remapped } = await resolveByRef(page, ref);
  const { kind, d } = await classify(locator);
  const label = await labelForRef(page, liveRef);
  const remap = remapped && liveRef !== ref ? ' [remapped]' : '';

  if (!pick) return { text: 'field-select needs --pick <label>', code: 1 };

  // Resolve the (optional) query — a --query-ref is PHI and is resolved in-process
  // and NEVER echoed; a literal --query may be echoed in errors.
  let query = typeof opts.query === 'string' ? opts.query : null;
  let queryIsSecret = false;
  if (opts.queryRef) {
    query = await opts.resolveDataRef(opts.queryRef);
    queryIsSecret = true;
  }
  // A masked echo of the query for error text (literal shown, PHI never is).
  const queryEcho = queryIsSecret ? '«query-ref»' : `"${query}"`;

  // ── REFUSALS: never guess on a control field-select can't commit. ──────────
  if (kind === 'text' || kind === 'date') {
    return { text: `"${label}" is ${kind} — use field-fill ${liveRef} <value>`, code: 1 };
  }
  if (kind === 'button' || kind === 'link') {
    return { text: `"${label}" is ${kind} — not selectable; use: click <selector>`, code: 1 };
  }
  if (kind === 'unknown') {
    return {
      text: `"${label}" is unclassifiable — fall back to: snapshot [selector] or net-observe`,
      code: 1,
    };
  }

  // ── checkbox / radio: a small, advertised (describeField.howToSet) path. ────
  if (kind === 'checkbox') {
    const want = normLabel(pick);
    if (want !== 'checked' && want !== 'unchecked') {
      return { text: `"${label}" is a checkbox — --pick must be "checked" or "unchecked"`, code: 1 };
    }
    try {
      await locator.setChecked(want === 'checked');
    } catch (e) {
      return { text: `could not set "${label}": ${e.message || e}`, code: 1 };
    }
    const now = (await locator.isChecked().catch(() => null)) ? 'checked' : 'unchecked';
    return { text: `selected "${pick}" = "${now}"${remap}`, code: 0 };
  }
  if (kind === 'radio') {
    try {
      await locator.check();
    } catch (e) {
      return { text: `could not check "${label}": ${e.message || e}`, code: 1 };
    }
    return { text: `selected "${pick}" = "checked"${remap}`, code: 0 };
  }

  // ── native <select>: match against the FULL option list from inspect(). ─────
  if (kind === 'select') {
    const all = (d && d.options ? d.options : []).map((o) => o.label);
    // --query narrows the pool first (matches the large-select howToSet hint),
    // keeping labels only — the ladder then runs over the narrowed labels.
    const q = query != null && query !== '' ? normLabel(query) : null;
    const pool = q ? all.filter((l) => normLabel(l).includes(q)) : all;
    const m = matchPick(pick, pool);
    if (m.ambiguous) {
      return {
        text: candidatesText(liveRef, `--pick "${pick}" matched multiple options — be more specific:`, pick, pool),
        code: 1,
      };
    }
    if (m.none) {
      return {
        text: candidatesText(liveRef, `no option matched --pick "${pick}"${q ? ` (query ${queryEcho})` : ''} — nearest:`, pick, pool.length ? pool : all),
        code: 1,
      };
    }
    const chosen = pool[m.index];
    try {
      await locator.selectOption({ label: chosen });
    } catch (e) {
      return { text: `could not select "${chosen}" on "${label}": ${e.message || e}`, code: 1 };
    }
    const committed = await locator.evaluate((el) => {
      const o = el.options[el.selectedIndex];
      return o ? (o.textContent || '').trim() : '';
    });
    if (normLabel(committed) !== normLabel(chosen)) {
      return { text: `select "${label}" did not commit "${chosen}" (now "${committed}")`, code: 1 };
    }
    return { text: `selected "${pick}" = "${committed}"${remap}`, code: 0 };
  }

  // ── virtualized listbox (only a window of options in the DOM): ARROW-WALK. ──
  if (kind === 'listbox') {
    const r = await walkToLabel(locator, pick, WALK_MAX_STEPS);
    if (r.committed == null) {
      // Can't enumerate a windowed list for candidates; name what we last saw.
      return {
        text:
          `no option matched --pick "${pick}" after walking ${r.steps} options` +
          (r.last ? ` (last seen "${r.last}")` : '') +
          ` — check the exact label with: field ${liveRef}\n` +
          `→ retry: field-select ${liveRef} --pick "<exact label>"`,
        code: 1,
      };
    }
    return { text: `selected "${pick}" = "${r.committed}"${remap}`, code: 0 };
  }

  // ── custom combobox (static or async), classifier's unrefined 'combobox'. ───
  if (kind === 'combobox' || kind === 'combobox-static' || kind === 'combobox-async') {
    let options;
    if (query != null && query !== '') {
      // Typed path: async autocomplete OR a static list we filter by typing.
      const settle = await typeQueryAndSettle(locator, query);
      if (!settle.settled) {
        return {
          text:
            'no options appeared for the query after 8s — try a longer/different ' +
            '--query, or check the API shortcut (net-observe)',
          code: 1,
        };
      }
      options = await harvestOptions(locator);
      if (!options || options.length === 0) {
        return {
          text: `the query ${queryEcho} returned no options — try a longer/different --query`,
          code: 1,
        };
      }
    } else {
      // No query: open a STATIC list and harvest. An empty harvest means the
      // control needs a query to load options (async) — say so, don't guess.
      await openCombo(locator);
      options = await harvestOptions(locator);
      if (!options || options.length === 0) {
        return {
          text:
            `"${label}" is an async combobox — it needs --query <text> ` +
            `(or --query-ref <key>) to load options`,
          code: 1,
        };
      }
    }

    const m = matchPick(pick, options);
    if (m.ambiguous) {
      return {
        text: candidatesText(liveRef, `--pick "${pick}" matched multiple options — be more specific:`, pick, options),
        code: 1,
      };
    }
    if (m.none) {
      return {
        text: candidatesText(liveRef, `no option matched --pick "${pick}" — nearest:`, pick, options),
        code: 1,
      };
    }
    const chosen = options[m.index];
    const committed = await commitComboOption(locator, m.index, chosen);
    if (committed == null) {
      return { text: `could not commit "${chosen}" on "${label}" (value did not change)`, code: 1 };
    }
    // A --query-ref query is PHI, but the COMMITTED option label is the agent's
    // necessary confirmation (like on-page content) — echo it unless the FIELD
    // itself is sensitive, in which case mask the read-back.
    const shown = d && d.sensitive ? '«filled»' : committed;
    return { text: `selected "${pick}" = "${shown}"${remap}`, code: 0 };
  }

  // Any residual kind (radiogroup/slider/switch/…): refuse rather than guess.
  return {
    text: `"${label}" is ${kind} — field-select can't commit this; inspect it with: field ${liveRef}`,
    code: 1,
  };
}
