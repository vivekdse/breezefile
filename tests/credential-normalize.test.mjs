// Unit tests for the pure site-credential LIST normalizer (task-d60860fb4d7f).
// The fetch/auth plumbing is Electron-coupled (CI lacks it), so we test the one
// pure transform: the server's { credentials: [{origin, username, updated_at}] }
// (NO passwords) → the client SavedCredential shape, dropping malformed rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const { normalizeCredentialList } = await import(
  join(repoRoot, 'electron', 'typebuild', 'credential-normalize.mjs')
);

test('maps the server list and renames updated_at → updatedAt', () => {
  const out = normalizeCredentialList({
    credentials: [
      { origin: 'https://a.test', username: 'alice', updated_at: '2026-06-27T00:00:00Z' },
      { origin: 'https://b.test', username: 'bob' },
    ],
  });
  assert.deepEqual(out, [
    { origin: 'https://a.test', username: 'alice', updatedAt: '2026-06-27T00:00:00Z' },
    { origin: 'https://b.test', username: 'bob' },
  ]);
});

test('drops rows with no origin and non-object junk', () => {
  const out = normalizeCredentialList({
    credentials: [
      { username: 'noorigin' },
      null,
      'str',
      42,
      { origin: '', username: 'blank' },
      { origin: 'https://ok.test', username: 'ok' },
    ],
  });
  assert.deepEqual(out, [{ origin: 'https://ok.test', username: 'ok' }]);
});

test('tolerates a missing/empty credentials array', () => {
  assert.deepEqual(normalizeCredentialList({}), []);
  assert.deepEqual(normalizeCredentialList({ credentials: null }), []);
  assert.deepEqual(normalizeCredentialList(null), []);
  assert.deepEqual(normalizeCredentialList('nope'), []);
});

test('coerces a non-string username to empty (never invents one)', () => {
  const out = normalizeCredentialList({
    credentials: [{ origin: 'https://x.test', username: 123 }],
  });
  assert.deepEqual(out, [{ origin: 'https://x.test', username: '' }]);
});

test('never carries a password field through (list is value-free)', () => {
  const out = normalizeCredentialList({
    credentials: [{ origin: 'https://x.test', username: 'u', password: 'LEAK' }],
  });
  assert.deepEqual(out, [{ origin: 'https://x.test', username: 'u' }]);
  assert.ok(!JSON.stringify(out).includes('LEAK'));
});
