// Unit coverage for the clean-Chrome UA stripping (task-bc3da6d26681). The
// embedded browser's default UA self-identifies as a non-browser runtime via
// the `TypeBuild/<ver>` and `Electron/<ver>` product tokens — no real Chrome
// emits either. Aggressive WAFs (Akamai/Imperva-class, observed on a health
// insurer's login proxy) deny-list on this. Electron-coupled wiring (per-view
// wc.setUserAgent in electron/browser/views.ts, the app.userAgentFallback
// backstop in electron/main.ts) can't be exercised without a live app/display,
// but the string-munging itself is pure and lives in user-agent-strip.mjs
// (electron/browser/user-agent.ts re-exports it) — assert its contract here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripElectronTokens,
  cleanChromeUserAgent,
} from '../electron/browser/user-agent-strip.mjs';

const REAL_ELECTRON_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'TypeBuild/0.1.20 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';

test('stripElectronTokens removes both the app product token and Electron/<ver>', () => {
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.doesNotMatch(cleaned, /TypeBuild/);
  assert.doesNotMatch(cleaned, /Electron/);
});

test('stripElectronTokens preserves the real Chrome version', () => {
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.match(cleaned, /Chrome\/130\.0\.6723\.191/);
});

test('stripElectronTokens preserves OS/platform info', () => {
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.match(cleaned, /X11; Linux x86_64/);
  assert.match(cleaned, /AppleWebKit\/537\.36/);
  assert.match(cleaned, /Safari\/537\.36/);
});

test('stripElectronTokens collapses whitespace left by removed tokens (no double spaces)', () => {
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.doesNotMatch(cleaned, /\s{2,}/);
  assert.equal(cleaned, cleaned.trim());
});

test('stripElectronTokens matches a stock Chrome UA shape exactly (nothing extra left over)', () => {
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.equal(
    cleaned,
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/130.0.6723.191 Safari/537.36',
  );
});

test('stripElectronTokens is idempotent on an already-clean UA', () => {
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.equal(stripElectronTokens(cleaned), cleaned);
});

test('stripElectronTokens is a no-op on a UA with no matching tokens', () => {
  const alreadyClean =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  assert.equal(stripElectronTokens(alreadyClean), alreadyClean);
});

test('stripElectronTokens respects a custom app product token name', () => {
  const ua = REAL_ELECTRON_UA.replace('TypeBuild/0.1.20', 'BreezeFile/2.0.0');
  const cleaned = stripElectronTokens(ua, 'BreezeFile');
  assert.doesNotMatch(cleaned, /BreezeFile/);
  assert.doesNotMatch(cleaned, /Electron/);
  assert.match(cleaned, /Chrome\/130\.0\.6723\.191/);
});

test("stripElectronTokens does not clip 'Chrome' when the app token is a substring-adjacent word", () => {
  // Regression guard: the app-product regex is word-boundary anchored, so it
  // must never eat into the Chrome/<ver> token that follows it.
  const cleaned = stripElectronTokens(REAL_ELECTRON_UA);
  assert.match(cleaned, /\bChrome\/[\d.]+\b/);
});

test('cleanChromeUserAgent strips tokens from a live runtime UA', () => {
  const cleaned = cleanChromeUserAgent(REAL_ELECTRON_UA, 'TypeBuild', '130.0.6723.191');
  assert.doesNotMatch(cleaned, /TypeBuild|Electron/);
  assert.match(cleaned, /Chrome\/130\.0\.6723\.191/);
});

test('cleanChromeUserAgent falls back to a composed Chrome UA when given an empty string', () => {
  const cleaned = cleanChromeUserAgent('', 'TypeBuild', '131.0.1.2');
  assert.doesNotMatch(cleaned, /TypeBuild|Electron/);
  assert.match(cleaned, /Chrome\/131\.0\.1\.2/);
  assert.match(cleaned, /Mozilla\/5\.0/);
});

test('cleanChromeUserAgent falls back gracefully when even the chrome version is missing', () => {
  const cleaned = cleanChromeUserAgent('   ', 'TypeBuild', undefined);
  assert.doesNotMatch(cleaned, /TypeBuild|Electron/);
  assert.match(cleaned, /Chrome\/[\d.]+/);
});
