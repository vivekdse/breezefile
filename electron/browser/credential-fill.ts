// Return-visit autofill: type a SAVED password into a login form in the embedded
// browser tab (task-4b786c018d78). This runs entirely in MAIN: the password is
// resolved from the site-keyed vault here and injected straight into the page via
// executeJavaScript. It is NEVER returned to the renderer or an agent — same
// value-never-in-agent-context discipline as the me.* fill path.
//
// ─── SECURITY INVARIANT ──────────────────────────────────────────────────────
// The password crosses only: server resolve → main heap → the page DOM (the
// trusted hop). It is interpolated into an executeJavaScript string that runs in
// the page world; the page can of course read its own filled field (cooperative
// boundary, not a sandbox — same threat model as task-data fill). We:
//   - never log the value (any thrown error is scrubbed of it),
//   - never return it to the caller (the injected script returns only a value-
//     free status string),
//   - clear nothing-extra: the value lives in the page's input, which is the
//     point of a fill.

import type { WebContents } from 'electron';
import { scrubError } from './scrub.mjs';

// Outcome of an autofill attempt — value-free. 'filled' = both/one field set;
// 'no-form' = no password field found; 'error' = injection failed (scrubbed).
export type FillResult = 'filled' | 'no-form' | 'error';

/** Build the page-side fill script. The username/password are interpolated as
 *  JSON string literals (so quotes/newlines can't break out). Returns a value-
 *  FREE status token, never the value. */
function fillScript(username: string, password: string): string {
  return `(() => {
  try {
    var U = ${JSON.stringify(username)};
    var P = ${JSON.stringify(password)};
    // Find the first visible password field and its form.
    var pw = null;
    var pws = document.querySelectorAll('input[type=password]');
    for (var i = 0; i < pws.length; i++) {
      var r = pws[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { pw = pws[i]; break; }
    }
    if (!pw) pw = pws[0] || null;
    if (!pw) return 'no-form';
    var form = pw.form || document;

    function setVal(el, v) {
      if (!el) return;
      try {
        // Drive the native setter so React/Vue controlled inputs see the change.
        var proto = Object.getPrototypeOf(el);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { try { el.value = v; } catch (e2) {} }
    }

    // Username: prefer autocomplete=username|email, else the nearest text/email
    // input preceding the password field (mirror of the capture heuristic).
    if (U) {
      var userEl = null;
      var inputs = Array.prototype.slice.call(
        (form.querySelectorAll ? form : document).querySelectorAll('input')
      );
      for (var j = 0; j < inputs.length; j++) {
        var ac = (inputs[j].getAttribute('autocomplete') || '').toLowerCase();
        if (ac === 'username' || ac === 'email') { userEl = inputs[j]; break; }
      }
      if (!userEl) {
        var pwIdx = inputs.indexOf(pw);
        for (var k = pwIdx - 1; k >= 0; k--) {
          var t = (inputs[k].type || 'text').toLowerCase();
          if (t === 'email' || t === 'text' || t === 'tel') { userEl = inputs[k]; break; }
        }
      }
      setVal(userEl, U);
    }
    setVal(pw, P);
    return 'filled';
  } catch (e) { return 'error'; }
})();`;
}

/**
 * Fill a saved (username, password) into the page's login form. Returns a
 * value-free FillResult. NEVER logs or returns the password; any thrown error is
 * scrubbed of the password before it can surface.
 */
export async function fillCredentialIntoPage(
  wc: WebContents,
  username: string,
  password: string,
): Promise<FillResult> {
  try {
    const r = (await wc.executeJavaScript(fillScript(username, password), true)) as unknown;
    if (r === 'filled' || r === 'no-form') return r;
    return 'error';
  } catch (err) {
    // Scrub the password out of any Playwright/V8 error text before it could be
    // logged by a caller. We swallow the detail and return a value-free status.
    void scrubError(err, password);
    return 'error';
  }
}
