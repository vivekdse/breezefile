// Teach-by-recording PAGE preload — runs INSIDE each embedded browser view.
//
// When the human is RECORDING (main toggles us on via the 'tb-record:set'
// IPC), we listen for their real interactions (click / input / change) and the
// page's navigations, compute every selector candidate we can from the DOM, and
// exfiltrate each action to MAIN over IPC as
//   { action, url, timestamp, candidates: [{ kind, selector }], placeholder }.
// MAIN then enriches each candidate with role+accname (from the a11y tree) and a
// matchCount (querySelectorAll length), and hands the whole thing to Claude Code
// so it can pick the most STABLE selector (see selector-candidates.mjs).
//
// WHY a preload, not CDP: the page is a native Electron WebContentsView, so a
// preload + addEventListener captures the human's actions with ZERO new
// dependency and WITHOUT a CDP debugger client (which would collide with
// Playwright's connectOverCDP — see connect.mjs). The a11y/role part is the one
// thing JS can't compute faithfully, so MAIN does that bit over the built-in
// webContents.debugger while Playwright is detached (time-share).
//
// PHI INVARIANT: we capture STRUCTURE, never values. For a text input we send
// the field's stable identity (name/id/label) as a PLACEHOLDER KEY and NEVER the
// typed characters. No field value, no innerText of contenteditable, ever leaves
// this preload. The recorder is for learning SELECTORS, not data.

import { contextBridge, ipcRenderer } from 'electron';

let recording = false;

// ─── selector-candidate computation (pure DOM reads) ─────────────────────────

const TESTID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];

/** Looks auto-generated (e.g. ember1234, css-1a2b3c, :r0:, mui-573)? Such ids
 *  are unstable across reloads/builds, so we DON'T treat them as a good id. */
function looksGenerated(s) {
  if (!s) return true;
  if (/^[:.]?r[0-9a-z]+:?$/i.test(s)) return true; // React useId, ember
  if (/\d{3,}/.test(s) && /^[a-z]+[-_]?\d+$/i.test(s)) return true; // mui-573, ember1234
  if (/^(css|sc|jsx|emotion)-[a-z0-9]{4,}$/i.test(s)) return true; // styled/emotion hashes
  if (/^[a-f0-9]{8,}$/i.test(s)) return true; // raw hash
  return false;
}

function cssEscape(s) {
  // The page has the real CSS.escape — use it; fall back defensively.
  try {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  } catch {
    /* ignore */
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function visibleText(el) {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 80 ? t : '';
}

function nthOfType(el) {
  const tag = el.tagName.toLowerCase();
  let i = 1;
  let sib = el;
  while ((sib = sib.previousElementSibling)) {
    if (sib.tagName.toLowerCase() === tag) i++;
  }
  return `${tag}:nth-of-type(${i})`;
}

/** A full structural CSS path from a stable-ish ancestor down to el. Last
 *  resort: brittle, but always unique. */
function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
    if (node.id && !looksGenerated(node.id)) {
      parts.unshift('#' + cssEscape(node.id));
      break; // an id anchors the path
    }
    parts.unshift(nthOfType(node));
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Compute every candidate selector we can read from the DOM for `el`.
 *  Returns [{ kind, selector }] (NO matchCount — MAIN adds that). role+name is
 *  intentionally absent; MAIN fills it from the accessibility tree. */
function candidatesFor(el) {
  const out = [];
  if (!el || el.nodeType !== 1) return out;

  for (const attr of TESTID_ATTRS) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (v) out.push({ kind: 'testid', selector: `[${attr}="${cssEscape(v)}"]` });
  }

  if (el.id && !looksGenerated(el.id)) {
    out.push({ kind: 'id', selector: '#' + cssEscape(el.id) });
  }

  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria && aria.trim()) {
    out.push({ kind: 'arialabel', selector: `[aria-label="${cssEscape(aria.trim())}"]` });
  }

  const txt = visibleText(el);
  if (txt) out.push({ kind: 'text', selector: `text=${txt}` });

  // Structural fallbacks — always present so there is always *something*.
  out.push({ kind: 'css', selector: cssPath(el) });
  out.push({ kind: 'nth', selector: nthOfType(el) });
  return out;
}

// ─── PHI-safe placeholder identity for inputs ────────────────────────────────
// For a typed/changed field we report HOW to find the field (a placeholder key
// derived from its stable identity) but NEVER the value.

function placeholderKeyFor(el) {
  if (!el || el.nodeType !== 1) return null;
  const name = el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'));
  if (name && !looksGenerated(name)) return name;
  const al = el.getAttribute && el.getAttribute('aria-label');
  if (al) return al.trim().slice(0, 40);
  // associated <label>
  if (el.labels && el.labels.length) {
    const lt = (el.labels[0].textContent || '').replace(/\s+/g, ' ').trim();
    if (lt) return lt.slice(0, 40);
  }
  const ph = el.getAttribute && el.getAttribute('placeholder');
  if (ph) return ph.trim().slice(0, 40);
  return el.tagName ? el.tagName.toLowerCase() : 'field';
}

// ─── capture ─────────────────────────────────────────────────────────────────

function emit(action, el, extra) {
  if (!recording) return;
  try {
    const payload = {
      action,
      url: location.href,
      timestamp: Date.now(),
      candidates: el ? candidatesFor(el) : [],
      ...extra,
    };
    ipcRenderer.sendToHost('tb-record:action', payload);
  } catch {
    /* never let recording break the page */
  }
}

function onClick(e) {
  const el = e.target && e.target.closest ? e.target.closest('*') : e.target;
  emit('click', el);
}

function onChange(e) {
  const el = e.target;
  if (!el || el.nodeType !== 1) return;
  // PHI: a placeholder KEY only — never the value.
  emit('change', el, { placeholder: placeholderKeyFor(el), inputType: el.type || el.tagName.toLowerCase() });
}

let inputTimer = null;
let lastInputEl = null;
function onInput(e) {
  // Debounce keystrokes into one "input" action per field (and never the text).
  lastInputEl = e.target;
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    const el = lastInputEl;
    inputTimer = null;
    lastInputEl = null;
    if (el && el.nodeType === 1) {
      emit('input', el, { placeholder: placeholderKeyFor(el), inputType: el.type || el.tagName.toLowerCase() });
    }
  }, 600);
}

// Navigation: SPA route changes + full loads. (Full loads also re-run this
// preload, so we additionally emit one on load while recording.)
function patchHistory() {
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    if (typeof orig !== 'function' || orig.__tbPatched) continue;
    const wrapped = function (...args) {
      const r = orig.apply(this, args);
      emit('navigate', null, { to: location.href });
      return r;
    };
    wrapped.__tbPatched = true;
    history[m] = wrapped;
  }
  window.addEventListener('popstate', () => emit('navigate', null, { to: location.href }));
  window.addEventListener('hashchange', () => emit('navigate', null, { to: location.href }));
}

function attachListeners() {
  // Capture phase so we see the event even if the app stops propagation.
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('input', onInput, true);
  patchHistory();
}

let attached = false;
function ensureAttached() {
  if (attached) return;
  attached = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachListeners, { once: true });
  } else {
    attachListeners();
  }
}

// MAIN toggles recording. We attach listeners lazily on first enable so a
// non-recording page pays nothing.
ipcRenderer.on('tb-record:set', (_e, on) => {
  recording = !!on;
  if (recording) {
    ensureAttached();
    emit('navigate', null, { to: location.href }); // anchor the session to the current page
  }
});

// Expose a tiny read-only flag for debugging in the page (no value access).
try {
  contextBridge.exposeInMainWorld('__tbRecord', { isRecording: () => recording });
} catch {
  /* contextBridge unavailable (no isolation) — non-fatal */
}
