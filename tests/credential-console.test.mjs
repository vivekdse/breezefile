// Unit tests for the version-robust console-message parsing that drives the
// credential-capture sentinel (task-890b0a7483c5). These cover the exact bug:
// Electron's 'console-message' listener signature varies by major, and reading
// the wrong arg made the sentinel never match so "Save password?" never fired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const { consoleMessageText, matchSentinelNonce } = await import(
  join(repoRoot, 'electron', 'browser', 'credential-console.mjs')
);

const SENTINEL = '__BF_CRED_CAPTURED__';

// ─── consoleMessageText: tolerate BOTH listener signatures ──────────────────

test('positional form: (level, message, line, source) → message text', () => {
  // The listener strips the leading Event; the remaining args are positional.
  assert.equal(
    consoleMessageText(1, `${SENTINEL}:abc123`, 42, 'https://x.test'),
    `${SENTINEL}:abc123`,
  );
});

test('object-details form: ({ message, level, ... }) → .message', () => {
  assert.equal(
    consoleMessageText({
      message: `${SENTINEL}:abc123`,
      level: 1,
      sourceUrl: 'https://x.test',
      lineNumber: 42,
    }),
    `${SENTINEL}:abc123`,
  );
});

test('returns the FIRST string arg (positional message ahead of source)', () => {
  assert.equal(consoleMessageText(2, 'hello', 7, 'src'), 'hello');
});

test('no message present → empty string (never throws)', () => {
  assert.equal(consoleMessageText(), '');
  assert.equal(consoleMessageText(0), '');
  assert.equal(consoleMessageText(null, undefined), '');
  assert.equal(consoleMessageText({ notMessage: 'x' }), '');
});

// ─── matchSentinelNonce: parse `${sentinel}:${nonce}` exactly ───────────────

test('matches sentinel and returns the trailing nonce', () => {
  assert.equal(matchSentinelNonce(`${SENTINEL}:n0nc3`, SENTINEL), 'n0nc3');
});

test('rejects non-sentinel lines (ordinary page logs)', () => {
  assert.equal(matchSentinelNonce('just a normal console log', SENTINEL), null);
  assert.equal(matchSentinelNonce('', SENTINEL), null);
});

test('rejects the bare sentinel with no nonce', () => {
  assert.equal(matchSentinelNonce(SENTINEL, SENTINEL), null);
  assert.equal(matchSentinelNonce(`${SENTINEL}:`, SENTINEL), null);
});

test('non-string input → null', () => {
  assert.equal(matchSentinelNonce(undefined, SENTINEL), null);
  assert.equal(matchSentinelNonce(123, SENTINEL), null);
});

// ─── end-to-end: object-details line round-trips to a nonce ─────────────────

test('e2e: object-details sentinel line extracts the right nonce', () => {
  const nonce = 'xyz789';
  const text = consoleMessageText({ message: `${SENTINEL}:${nonce}`, level: 1 });
  assert.equal(matchSentinelNonce(text, SENTINEL), nonce);
});
