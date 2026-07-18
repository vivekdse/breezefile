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
