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
// SPA LIMITATION (documented): many modern login forms submit via fetch/XHR with
// preventDefault and never fire a real `submit` event — those are NOT captured
// here. This is the deliberate first cut: real <form> submits (classic POST
// logins, and the many SPAs that still let the form submit event fire before
// intercepting) are covered. See the report for which sites worked.

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

    function onSubmit(ev) {
      try {
        var form = ev.target;
        if (!form || form.tagName !== 'FORM') return;
        var pw = form.querySelector('input[type=password]');
        if (!pw || !pw.value) return; // no password typed — nothing to save
        var userEl = pickUsername(form, pw);
        var cred = {
          origin: W.location.origin,
          username: userEl && userEl.value ? String(userEl.value) : '',
          password: String(pw.value)
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
      } catch (e) { /* never throw into the page's submit */ }
    }

    // Capture phase so we see the submit even if the page stops propagation.
    document.addEventListener('submit', onSubmit, true);
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
