// Unit tests for the pure credential validator (task-1188c6535e91). The page
// injection + console wiring need a live WebContents (CI lacks one), so we test
// the one pure, security-relevant unit: sanitizeCapturedCredential, which
// decides whether a pulled object is a usable login to surface to the "Save
// password?" prompt.
//
// SECURITY assertions baked in: a capture with no password is dropped (we never
// pop a prompt for an empty save), and a value-free object never yields a
// credential.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const { sanitizeCapturedCredential } = await import(
  join(repoRoot, 'electron', 'browser', 'credential-sanitize.mjs')
);

test('accepts a full credential (origin + username + password)', () => {
  const c = sanitizeCapturedCredential({
    origin: 'https://portal.example.com',
    username: 'alice@example.com',
    password: 'hunter2',
  });
  assert.deepEqual(c, {
    origin: 'https://portal.example.com',
    username: 'alice@example.com',
    password: 'hunter2',
  });
});

test('accepts a password-only credential (username may be blank)', () => {
  const c = sanitizeCapturedCredential({
    origin: 'https://x.test',
    username: '',
    password: 'p',
  });
  assert.ok(c, 'a blank username is still a valid save');
  assert.equal(c.username, '');
  assert.equal(c.password, 'p');
});

test('drops a capture with no password (never prompt for an empty save)', () => {
  assert.equal(
    sanitizeCapturedCredential({ origin: 'https://x.test', username: 'a', password: '' }),
    null,
  );
  assert.equal(
    sanitizeCapturedCredential({ origin: 'https://x.test', username: 'a' }),
    null,
  );
});

test('drops a capture with no/opaque origin', () => {
  assert.equal(
    sanitizeCapturedCredential({ origin: '', username: 'a', password: 'p' }),
    null,
  );
  // about:blank / sandboxed iframe origins serialize to the string "null".
  assert.equal(
    sanitizeCapturedCredential({ origin: 'null', username: 'a', password: 'p' }),
    null,
  );
});

test('drops non-objects and value-free junk', () => {
  for (const junk of [null, undefined, 'str', 42, true, {}, { origin: 1, password: 2 }]) {
    assert.equal(sanitizeCapturedCredential(junk), null);
  }
});

test('coerces nothing it should not: non-string fields are treated as absent', () => {
  const c = sanitizeCapturedCredential({
    origin: 'https://x.test',
    username: 12345, // not a string -> dropped to ''
    password: 'p',
  });
  assert.ok(c);
  assert.equal(c.username, '');
});
