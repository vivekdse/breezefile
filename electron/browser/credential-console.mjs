// Pure helper for the credential-capture console sentinel (task-1188c6535e91 /
// task-890b0a7483c5). Split into its own .mjs (no Electron) so it is
// unit-testable without a live WebContents. Distinct basename avoids the
// same-basename .mjs/.ts build gotcha.
//
// WHY THIS EXISTS — the bug it fixes:
// Electron's webContents `'console-message'` event has had TWO incompatible
// listener signatures across majors:
//   • OLD (positional, what older docs/snippets show):
//       (event, level, message, lineNumber, sourceId)   ← message is arg #3
//   • NEW (the object-details form; present in Electron 33.x's type defs here
//     and 36+):
//       (event, { message, level, sourceUrl, lineNumber, ... })  ← arg #2.message
// A handler that reads the wrong argument silently never matches our value-free
// sentinel, so capture no-ops with NO error. `consoleMessageText` reads the
// message text from WHICHEVER shape arrived, so the sentinel match is robust to
// the installed Electron version. Pass the listener args AFTER the leading
// Event.

/**
 * Extract the console message TEXT from a webContents 'console-message' event's
 * post-event arguments, tolerating both the positional and the object-details
 * signatures. Never throws; returns '' when no text can be found.
 *
 * @param {...unknown} args  The listener args AFTER the leading Event, i.e.
 *   positional form: (level, message, lineNumber, sourceId)
 *   object form:     ({ message, level, ... })
 * @returns {string} the message text, or '' if none.
 */
export function consoleMessageText(...args) {
  for (const a of args) {
    // Positional form: the message is the first STRING argument (the leading
    // `level` is a number, so a string arg is the message text).
    if (typeof a === 'string') return a;
    // Object-details form: the message lives on `.message`.
    if (a && typeof a === 'object' && typeof a.message === 'string') {
      return a.message;
    }
  }
  return '';
}

/**
 * Given the full console message text and the value-free sentinel marker,
 * return the trailing nonce iff the text is `${sentinel}:${nonce}`, else null.
 * Keeps the (fragile, easy-to-get-wrong) parse in one tested place.
 *
 * @param {string} text
 * @param {string} sentinel
 * @returns {string|null}
 */
export function matchSentinelNonce(text, sentinel) {
  if (typeof text !== 'string') return null;
  const prefix = sentinel + ':';
  if (!text.startsWith(prefix)) return null;
  const nonce = text.slice(prefix.length);
  return nonce.length > 0 ? nonce : null;
}
