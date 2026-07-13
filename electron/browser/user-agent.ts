// Clean-Chrome User-Agent for agent-driven browsing.
//
// WHY: Electron's default UA self-identifies as a non-browser runtime —
//   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
//     TypeBuild/0.1.20 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36
// The `TypeBuild/<ver>` (app product token) and `Electron/<ver>` tokens NEVER
// appear in a real Chrome UA. Aggressive WAFs (Akamai/Imperva-class — observed
// on Cigna's login proxy) allow/deny-list on the UA string and reject unknown
// product tokens / anything containing "Electron", since Electron apps are a
// common credential-stuffing / RPA vector. The deep fingerprint surface here is
// already clean (navigator.webdriver undefined, CDP/headless checks pass on
// bot.sannysoft.com + browserscan.net) — this single string was the leak.
//
// FIX: strip the two offending tokens so we present as the underlying Chrome.
// We derive from the LIVE UA (not a hard-coded string) so the Chrome version
// stays accurate across Electron upgrades instead of going stale.

/**
 * Strip Electron's product tokens from a UA string, leaving a stock Chrome UA.
 * Removes the app product token (matched by `appProduct`, e.g. "TypeBuild") and
 * the `Electron/<version>` token, then normalizes the whitespace they leave.
 * Idempotent and safe on an already-clean UA.
 */
export function stripElectronTokens(ua: string, appProduct = 'TypeBuild'): string {
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
 * so `app.userAgentFallback` reflects the real runtime UA. Falls back to
 * composing one from `process.versions.chrome` if the passed UA is empty.
 */
export function cleanChromeUserAgent(runtimeUa: string, appProduct = 'TypeBuild'): string {
  if (runtimeUa && runtimeUa.trim()) return stripElectronTokens(runtimeUa, appProduct);
  // Defensive fallback: build a plausible desktop-Linux Chrome UA from the
  // Chromium version Electron reports. Only reached if the caller had no UA.
  const chrome = process.versions.chrome || '130.0.0.0';
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${chrome} Safari/537.36`
  );
}
