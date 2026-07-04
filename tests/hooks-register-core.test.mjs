// task-8997b15a37d9 — regression test for the SessionStart/PreCompact
// `breeze prime` stale-hook self-heal. The removed breeze CLI's
// SessionStart/PreCompact hooks (`"<bundled-path>/bin/breeze" prime`) errored
// every operator session ("bin/breeze: not found") once bin/breeze was
// deleted (912264a) — but the isBreezeHook predicate that decides what
// registerBreezeHooks() strips no longer recognized that command shape, so an
// already-seeded ~/.claude/settings.json never got cleaned. isBreezeHook /
// withoutBreezeMatchers are the pure core (electron/hooks-register-core.mjs,
// no Electron/fs) — see hooks-register.ts for the settings.json read/write
// plumbing that calls them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBreezeHook, withoutBreezeMatchers } from '../electron/hooks-register-core.mjs';

test('isBreezeHook recognizes the current claude-hook.sh command', () => {
  assert.equal(
    isBreezeHook({ type: 'command', command: 'sh "/home/user/.breezefile/claude-hook.sh" busy' }),
    true,
  );
});

test('isBreezeHook recognizes the RETIRED breeze-prime SessionStart command (self-heal)', () => {
  assert.equal(
    isBreezeHook({
      type: 'command',
      command: '"/home/user/git_repos/breezefile/bin/breeze" prime',
    }),
    true,
  );
  // Packaged-app resource path shape too.
  assert.equal(
    isBreezeHook({ type: 'command', command: '"/Applications/TypeBuild.app/Contents/Resources/breeze" prime' }),
    true,
  );
});

test('isBreezeHook leaves foreign commands untouched', () => {
  assert.equal(isBreezeHook({ type: 'command', command: 'echo hi' }), false);
  assert.equal(isBreezeHook({ type: 'command', command: 'node ./my-hook.js' }), false);
  assert.equal(isBreezeHook({ command: undefined }), false);
});

test('withoutBreezeMatchers strips a stale SessionStart breeze-prime entry entirely', () => {
  // Shape of an existing ~/.claude/settings.json's hooks.SessionStart from
  // before 912264a removed the breeze CLI — the exact stale entry that used
  // to error every session.
  const staleSessionStart = [
    {
      matcher: '',
      hooks: [{ type: 'command', command: '"/home/user/.breezefile/breeze" prime' }],
    },
  ];
  const cleaned = withoutBreezeMatchers(staleSessionStart);
  assert.deepEqual(cleaned, []);
});

test('withoutBreezeMatchers preserves a foreign hook alongside a stale breeze one', () => {
  const mixed = [
    {
      hooks: [
        { type: 'command', command: '"/home/user/.breezefile/breeze" prime' },
        { type: 'command', command: 'echo user-hook' },
      ],
    },
  ];
  const cleaned = withoutBreezeMatchers(mixed);
  assert.deepEqual(cleaned, [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }]);
});

test('withoutBreezeMatchers is a no-op on undefined/empty input', () => {
  assert.deepEqual(withoutBreezeMatchers(undefined), []);
  assert.deepEqual(withoutBreezeMatchers([]), []);
});

// Simulates registerBreezeHooks()'s per-event cleanup loop (hooks-register.ts)
// without needing a TS import: an event registerBreezeHooks does NOT own
// (e.g. SessionStart) that cleans out to fully empty must be DROPPED from the
// next hooks object, not left as a dangling `"SessionStart": []`.
test('a foreign event that cleans to empty is dropped, not left dangling', () => {
  const oldHooks = {
    SessionStart: [
      { hooks: [{ type: 'command', command: '"/home/user/.breezefile/breeze" prime' }] },
    ],
    Notification: [{ hooks: [{ type: 'command', command: 'echo notify' }] }],
  };
  const nextHooks = {};
  for (const event of Object.keys(oldHooks)) {
    const cleaned = withoutBreezeMatchers(oldHooks[event]);
    if (cleaned.length > 0) nextHooks[event] = cleaned;
  }
  assert.equal('SessionStart' in nextHooks, false);
  assert.deepEqual(nextHooks.Notification, oldHooks.Notification);
});
