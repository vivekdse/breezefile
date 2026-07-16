// Pure UA-stripping logic (no Electron, no DOM) so it is unit-testable without
// a live app/WebContents. Split out of user-agent.ts for the same reason as
// credential-sanitize.mjs. Different basename from the .ts on purpose — avoids
// the sibling .mjs/.ts same-basename build gotcha.
//
// WHY: Electron's default UA self-identifies as a non-browser runtime —
//   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
//     TypeBuild/0.1.20 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36
// The `TypeBuild/<ver>` (app product token) and `Electron/<ver>` tokens NEVER
// appear in a real Chrome UA. Aggressive WAFs (Akamai/Imperva-class — observed
// on Cigna's login proxy) allow/deny-list on the UA string and reject unknown
// product tokens / anything containing "Electron", since Electron apps are a
// common credential-stuffing / RPA vector.

/**
 * Strip Electron's product tokens from a UA string, leaving a stock Chrome UA.
 * Removes the app product token (matched by `appProduct`, e.g. "TypeBuild") and
 * the `Electron/<version>` token, then normalizes the whitespace they leave.
 * Idempotent and safe on an already-clean UA.
 * @param {string} ua
 * @param {string} [appProduct]
 * @returns {string}
 */
export function stripElectronTokens(ua, appProduct = 'TypeBuild') {
  return ua
    // `AppProduct/1.2.3` — anchored to a word boundary so it can't clip Chrome.
    .replace(new RegExp(`\\b${appProduct}\\/[^\\s]+\\s*`, 'g'), '')
    // `Electron/33.4.11`
    .replace(/\bElectron\/[^\s]+\s*/g, '')
    // Collapse any double-spaces the removals leave, and trim.
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The clean Chrome UA the whole app should present. Call AFTER `app.whenReady()`
 * so the passed-in runtime UA reflects the real runtime UA. Falls back to
 * composing one from `chromeVersion` if the passed UA is empty.
 * @param {string} runtimeUa
 * @param {string} [appProduct]
 * @param {string} [chromeVersion] - process.versions.chrome, injected so this
 *   stays dependency-free; defaults to a recent stable version.
 * @returns {string}
 */
export function cleanChromeUserAgent(runtimeUa, appProduct = 'TypeBuild', chromeVersion = '130.0.0.0') {
  if (runtimeUa && runtimeUa.trim()) return stripElectronTokens(runtimeUa, appProduct);
  // Defensive fallback: build a plausible desktop-Linux Chrome UA from the
  // Chromium version Electron reports. Only reached if the caller had no UA.
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${chromeVersion} Safari/537.36`
  );
}
