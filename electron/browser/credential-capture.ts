// Login-submit detection + credential capture for the EMBEDDED browser tab
// (task-1188c6535e91). The embedded tab is a bare WebContentsView with NO
// preload / content-script, so we observe the browsed page by INJECTING a small
// capturing `submit` listener via wc.executeJavaScript, re-injected on every
// navigation (did-navigate / did-frame-navigated). When the human submits a
// form that has a password field, we capture { origin, username, password } and
// emit `browser:credential-captured` to the renderer (consumed by the
// "Save password?" prompt — task-ad89064bf45f).
//
// ─── SECURITY INVARIANT (non-negotiable) ────────────────────────────────────
// The captured PASSWORD is memory-only on the page→main→renderer path. It is
// NEVER written to disk, logs, notifications, browser:state, screenshots, or an
// agent's context. To honour that with a preload-less view we use a TWO-STEP
// channel:
//   1. The injected listener stashes the credential on a NON-enumerable page
//      global and emits a value-FREE SENTINEL via console.debug — the sentinel
//      string carries NO username/password, only a marker + a nonce.
//   2. main hears the sentinel on the 'console-message' event and PULLS the
//      credential object straight into main's heap via a fresh executeJavaScript
//      (a function return value — it never becomes a console/log line). The page
//      global is cleared on pull so it doesn't linger in the page heap.
// So the only thing that ever crosses the console (the one surface devtools /
// logging could capture) is the value-free sentinel. The password rides only an
// executeJavaScript return value and an in-memory IPC send.
//
// ─── SITE-CLASS COVERAGE (which mechanic catches which login) ───────────────
// Three capture mechanics, all feeding the SAME value-free sentinel + memory-only
// pull path below — adding signals never adds a new persistence channel:
//   1. CLASSIC <form> POST  → the capture-phase `submit` listener. Covers server-
//      rendered logins and SPAs that let the submit event fire before posting.
//   2. SPA preventDefault + button click (no real submit event) → a capture-phase
//      `click` listener on submit-like controls (button[type=submit], a generic
//      <button>/[role=button] sharing a form/container with a password field),
//      plus Enter pressed inside a password field. Covers React/Vue logins that
//      call ev.preventDefault() and POST via fetch/XHR from an onClick handler.
//   3. SPA fetch/XHR POST with NO button we recognized (programmatic submit,
//      custom widgets) → a thin wrapper around window.fetch and
//      XMLHttpRequest.send that, when a request carries the live password field's
//      value, fires the same capture. The wrapper inspects the OUTGOING body only
//      to confirm the typed password is being sent; it forwards the real call
//      untouched and never reads/keeps the RESPONSE.
// De-dup: every mechanic routes through `tryCapture`, which re-stashes the latest
// {origin,username,password} and re-emits the sentinel; main pulls once per
// sentinel, and a second sentinel for the same login is a cheap idempotent pull.
//
// VALUE-FREE INVARIANT for the new signals: none of the click/keydown/fetch paths
// log, post, or persist the password. They only (a) read the live field value
// into the same non-enumerable `__bfCred` stash and (b) emit the value-free
// sentinel — identical to the form path. The fetch wrapper never copies the body
// value anywhere; it compares-and-discards.

import type { WebContents, BrowserWindow } from 'electron';
// Pure validation lives in a sibling .mjs (no Electron) so it is unit-testable;
// different basename avoids the same-basename .mjs/.ts build gotcha.
import { sanitizeCapturedCredential } from './credential-sanitize.mjs';
// Pure, version-robust console-message parsing (the root cause of the
// "Save password? never fires" bug — task-890b0a7483c5). Distinct basename, no
// .ts sibling, so the bare-import build gotcha does not apply.
import { consoleMessageText, matchSentinelNonce } from './credential-console.mjs';

// One captured login as it crosses page→main→renderer. PHI-ish secret: the
// `password` is memory-only and must never be logged or persisted by any
// consumer until the user accepts the save prompt.
export interface CapturedCredential {
  origin: string;
  username: string;
  password: string;
}

// A per-injection nonce keeps the sentinel from being spoofable by page script
// and lets us ignore stale/foreign console lines. Regenerated each injection.
function makeNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// The page-side capture script (stringified, run in the browsed page's world via
// executeJavaScript). It is IDEMPOTENT (guards against double-install across
// re-injections) and emits only a value-free sentinel. Kept dependency-free and
// defensive — it runs in a hostile page.
//
// Username best-guess (in priority order): an input with autocomplete=username,
// else the password field's nearest PRECEDING email/text input in the same form,
// else any email input, else the first text input.
function captureScript(nonce: string, sentinel: string): string {
  return `(() => {
  try {
    var W = window;
    // Re-injection: refresh the active nonce but install the listener once.
    W.__bfCredNonce = ${JSON.stringify(nonce)};
    if (W.__bfCredInstalled) return 'rearmed';
    W.__bfCredInstalled = true;

    var SENTINEL = ${JSON.stringify(sentinel)};

    function pickUsername(form, pw) {
      var inputs = Array.prototype.slice.call(
        form.querySelectorAll('input')
      );
      // 1. explicit autocomplete=username
      for (var i = 0; i < inputs.length; i++) {
        var ac = (inputs[i].getAttribute('autocomplete') || '').toLowerCase();
        if (ac === 'username' || ac === 'email') return inputs[i];
      }
      // 2. nearest text/email input PRECEDING the password field
      var pwIdx = inputs.indexOf(pw);
      for (var j = pwIdx - 1; j >= 0; j--) {
        var t = (inputs[j].type || 'text').toLowerCase();
        if (t === 'email' || t === 'text' || t === 'tel') return inputs[j];
      }
      // 3. any email input anywhere in the form
      for (var k = 0; k < inputs.length; k++) {
        if ((inputs[k].type || '').toLowerCase() === 'email') return inputs[k];
      }
      // 4. first non-password text input
      for (var m = 0; m < inputs.length; m++) {
        var tt = (inputs[m].type || 'text').toLowerCase();
        if (tt !== 'password' && tt !== 'hidden' && tt !== 'submit' && tt !== 'button') {
          return inputs[m];
        }
      }
      return null;
    }

    // The ONE place a captured login is stashed + sentinel-emitted. Every
    // mechanic (form submit, button click, Enter, fetch/XHR) funnels here so
    // there is a single value-free handoff. pwEl is the live password field;
    // scope (a form OR a container element) bounds the username search.
    function tryCapture(pwEl, scope) {
      try {
        if (!pwEl || !pwEl.value) return; // no password typed — nothing to save
        var userEl = pickUsername(scope || document, pwEl);
        var cred = {
          origin: W.location.origin,
          username: userEl && userEl.value ? String(userEl.value) : '',
          password: String(pwEl.value)
        };
        // Stash on a NON-enumerable global so the page's own enumeration / JSON
        // serialization of window won't sweep it up, and main can pull it.
        try {
          Object.defineProperty(W, '__bfCred', {
            value: cred, configurable: true, enumerable: false, writable: true
          });
        } catch (e) { W.__bfCred = cred; }
        // Emit ONLY the value-free sentinel (marker + current nonce). NO
        // username, NO password ever touches the console.
        // Use console.log (info level), NOT console.debug: Electron's
        // webContents 'console-message' event does not reliably surface
        // verbose/debug-level lines (renderer logging threshold), so a
        // debug-level sentinel could be silently dropped before main ever
        // sees it — a contributing cause of task-890b0a7483c5.
        try { console.log(SENTINEL + ':' + W.__bfCredNonce); } catch (e) {}
      } catch (e) { /* never throw into the page's handler */ }
    }

    // Find the visible/typed password field nearest a triggering element (or the
    // first password field on the page as a fallback). Returns null if none.
    function findPasswordField(near) {
      // Prefer a password field inside the same form as the trigger.
      var f = near && near.form ? near.form : (near && near.closest ? near.closest('form') : null);
      if (f) {
        var inF = f.querySelector('input[type=password]');
        if (inF) return inF;
      }
      // Else: a password field with a value anywhere (the user clearly typed it).
      var all = document.querySelectorAll('input[type=password]');
      for (var i = 0; i < all.length; i++) { if (all[i].value) return all[i]; }
      return all[0] || null;
    }

    // The username-search scope for a trigger: its form if any, else the nearest
    // common container, else document.
    function scopeFor(pwEl, near) {
      if (pwEl && pwEl.form) return pwEl.form;
      if (near && near.closest) {
        var c = near.closest('form, [role=form], section, div, main, body');
        if (c) return c;
      }
      return document;
    }

    // ── 1. CLASSIC <form> submit (capture phase, survives stopPropagation) ──
    function onSubmit(ev) {
      try {
        var form = ev.target;
        if (!form || form.tagName !== 'FORM') return;
        var pw = form.querySelector('input[type=password]');
        if (!pw) return;
        tryCapture(pw, form);
      } catch (e) { /* never throw into the page's submit */ }
    }
    document.addEventListener('submit', onSubmit, true);

    // ── 2a. SPA button CLICK (preventDefault logins fire no submit event) ──
    // Treat as a submit trigger: an explicit submit control, or a generic
    // button / role=button that shares a form or container with a password
    // field that has a value. We read the field at click time (before the SPA's
    // own handler may clear it).
    function looksLikeSubmit(el) {
      try {
        if (!el) return false;
        var tag = (el.tagName || '').toUpperCase();
        var type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
        if (tag === 'BUTTON' && (type === 'submit' || type === '' )) return true;
        if (tag === 'INPUT' && (type === 'submit' || type === 'button')) return true;
        if (el.getAttribute && (el.getAttribute('role') || '').toLowerCase() === 'button') return true;
        if (tag === 'A' && el.getAttribute && el.hasAttribute('href') === false) return true;
        return false;
      } catch (e) { return false; }
    }
    function onClick(ev) {
      try {
        var t = ev.target;
        // Walk up to the nearest clickable control we recognize.
        var ctrl = t && t.closest
          ? t.closest('button, input[type=submit], input[type=button], [role=button], a')
          : null;
        if (!ctrl || !looksLikeSubmit(ctrl)) return;
        var pw = findPasswordField(ctrl);
        if (!pw || !pw.value) return; // only when a password is actually present
        tryCapture(pw, scopeFor(pw, ctrl));
      } catch (e) { /* never throw into the page's click */ }
    }
    document.addEventListener('click', onClick, true);

    // ── 2b. ENTER inside a password field (submit-on-enter, no button) ──
    function onKeydown(ev) {
      try {
        if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
        var el = ev.target;
        if (!el || (el.type || '').toLowerCase() !== 'password') return;
        if (!el.value) return;
        tryCapture(el, scopeFor(el, el));
      } catch (e) { /* never throw into the page's keydown */ }
    }
    document.addEventListener('keydown', onKeydown, true);

    // ── 3. fetch / XHR credential POST (programmatic submit, custom widgets) ──
    // Last-resort net for logins with NO recognizable button. We wrap fetch and
    // XHR.send and, IF a password field currently holds a value AND that value
    // appears in the OUTGOING request body, fire the same capture. We inspect the
    // outgoing body ONLY to confirm the typed password is being sent; we forward
    // the original call untouched and never touch the response. Value-free: the
    // body is compared to the live field and discarded — nothing is logged/kept.
    function livePasswordField() {
      var all = document.querySelectorAll('input[type=password]');
      for (var i = 0; i < all.length; i++) { if (all[i].value) return all[i]; }
      return null;
    }
    function bodyContains(body, secret) {
      try {
        if (!secret) return false;
        if (typeof body === 'string') return body.indexOf(secret) !== -1;
        if (body && typeof body.toString === 'function') {
          // URLSearchParams / FormData-ish: toString may include the value.
          var s = '' + body;
          if (s && s !== '[object Object]' && s.indexOf(secret) !== -1) return true;
        }
      } catch (e) {}
      return false;
    }
    function maybeCaptureFromBody(body) {
      try {
        var pw = livePasswordField();
        if (!pw || !pw.value) return;
        if (!bodyContains(body, pw.value)) return; // not a credential POST
        tryCapture(pw, scopeFor(pw, pw));
      } catch (e) {}
    }
    try {
      var _fetch = W.fetch;
      if (typeof _fetch === 'function' && !W.__bfFetchHooked) {
        W.__bfFetchHooked = true;
        W.fetch = function (input, init) {
          try {
            var b = init && init.body;
            // Only string-ish bodies are safe/cheap to scan without consuming a
            // stream; Request objects / Blobs are left to the button paths.
            if (b) maybeCaptureFromBody(b);
          } catch (e) {}
          return _fetch.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      var XHR = W.XMLHttpRequest;
      if (XHR && XHR.prototype && !XHR.prototype.__bfSendHooked) {
        XHR.prototype.__bfSendHooked = true;
        var _send = XHR.prototype.send;
        XHR.prototype.send = function (body) {
          try { if (body) maybeCaptureFromBody(body); } catch (e) {}
          return _send.apply(this, arguments);
        };
      }
    } catch (e) {}

    return 'installed';
  } catch (e) { return 'error'; }
})();`;
}

// The pull script: returns the stashed credential object straight to main (an
// executeJavaScript return value, never a log line) and CLEARS it from the page
// heap. Returns null if nothing is stashed or the nonce doesn't match.
function pullScript(nonce: string): string {
  return `(() => {
  try {
    var W = window;
    if (W.__bfCredNonce !== ${JSON.stringify(nonce)}) return null;
    var c = W.__bfCred || null;
    try { delete W.__bfCred; } catch (e) { W.__bfCred = undefined; }
    return c;
  } catch (e) { return null; }
})();`;
}

/**
 * Wire login-capture onto one embedded browser webContents. Re-injects the
 * capturing listener on every navigation, listens for the value-free sentinel,
 * pulls the credential into main, and forwards `browser:credential-captured`
 * { id, origin, username } + password to the renderer.
 *
 * `onCaptured` receives the full credential (incl. password) — the caller (ipc.ts)
 * forwards it over IPC to the trusted renderer prompt and does NOT log it.
 */
export function wireCredentialCapture(
  wc: WebContents,
  win: BrowserWindow,
  id: number,
  onCaptured: (cred: CapturedCredential, id: number) => void,
): void {
  let nonce = makeNonce();
  // A short marker; the nonce is appended at emit time. Value-free by design.
  const SENTINEL = '__BF_CRED_CAPTURED__';

  const inject = (): void => {
    nonce = makeNonce();
    // Fire-and-forget; a navigation mid-inject just means the next nav re-injects.
    void wc.executeJavaScript(captureScript(nonce, SENTINEL), true).catch(() => {});
  };

  // Inject on first load and every navigation (top frame + sub-frames, since a
  // login form may live in an iframe). did-frame-navigated covers sub-frames.
  // Each event has its own arg signature; our handler ignores args, so register
  // through a loosely-typed `.on` (the events are stringly distinct per Electron).
  const onWc = wc.on.bind(wc) as (ev: string, listener: () => void) => void;
  onWc('did-navigate', inject);
  onWc('did-frame-navigated', inject);
  onWc('dom-ready', inject);

  // The ONLY thing crossing the console is the value-free sentinel; we use it
  // purely as a "go pull" signal, then read the credential out-of-band.
  // Electron's 'console-message' listener has shipped TWO signatures across
  // majors — positional (event, level, message, line, source) and an
  // object-details (event, { message, ... }) form. Reading the wrong arg means
  // the sentinel never matches and capture silently no-ops (root cause of
  // task-890b0a7483c5). `consoleMessageText` reads the text from whichever
  // shape arrived; we pass every post-event arg so it is version-robust.
  const onConsole = (_event: unknown, ...rest: unknown[]): void => {
    const text = consoleMessageText(...rest);
    // The sentinel carries the nonce after the marker; require a match so a page
    // can't spoof a pull of a stale/foreign credential.
    const got = matchSentinelNonce(text, SENTINEL);
    if (got == null || got !== nonce) return;
    void wc
      .executeJavaScript(pullScript(nonce), true)
      .then((raw) => {
        const cred = sanitizeCapturedCredential(raw);
        if (!cred) return;
        if (win.webContents.isDestroyed()) return;
        onCaptured(cred, id);
      })
      .catch(() => {
        /* page gone / nav raced — nothing to capture, never log */
      });
  };
  // `console-message` is the public event name on Electron's webContents. Its
  // arg shape varies across Electron majors (positional level/message vs a
  // details object); onConsole tolerates both, so register loosely.
  (wc.on.bind(wc) as (ev: string, listener: (...a: unknown[]) => void) => void)(
    'console-message',
    onConsole as (...a: unknown[]) => void,
  );
}
