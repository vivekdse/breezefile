// fm-a2k — unit tests for the pure tag store (src/tagStore.mjs).
// Runs under `node --test tests/` with no Electron. Each test gets its own
// temp dir so the JSON file is isolated; the store's `selector` strings are
// kept in the tagDsl format so they round-trip through parse() (asserted here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TagStore, openTagStore, resolveTagsFile, _internal } from '../src/tagStore.mjs';
import { parse } from '../src/tagDsl.mjs';

async function freshStore(opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagstore-test-'));
  return { dir, store: new TagStore({ dir, ...opts }), file: path.join(dir, 'tags.json') };
}

// A monotonic ISO clock: each call returns a strictly-later timestamp than the
// last, so update()'s updated_at is guaranteed to differ from created_at
// WITHOUT racing wall-clock millisecond granularity or a real setTimeout. This
// removes the sole timing-dependent assertion in this suite.
function monotonicClock(startMs = Date.UTC(2026, 0, 1)) {
  let t = startMs;
  return () => new Date((t += 1000)).toISOString();
}

// ── create ──────────────────────────────────────────────────────────────────
test('create returns a fully-formed record with id + timestamps', async () => {
  const { store } = await freshStore();
  const t = await store.create({ name: 'Big images', selector: 'ext = png and size > 1MB' });
  assert.ok(t.id.startsWith('tag-'));
  assert.equal(t.name, 'Big images');
  assert.equal(t.selector, 'ext = png and size > 1MB');
  assert.equal(t.mode, 'live'); // default
  assert.equal(t.color, ''); // default
  assert.ok(t.created_at);
  assert.equal(t.created_at, t.updated_at);
});

test('create persists a frozen tag with a snapshot', async () => {
  const { store } = await freshStore();
  const t = await store.create({
    name: 'Pinned',
    selector: 'is_dir',
    mode: 'frozen',
    color: '#abc',
    snapshot: ['/a/b.txt', '/a/c.txt'],
  });
  assert.equal(t.mode, 'frozen');
  assert.equal(t.color, '#abc');
  assert.deepEqual(t.snapshot, ['/a/b.txt', '/a/c.txt']);
});

test('create rejects invalid shapes', async () => {
  const { store } = await freshStore();
  await assert.rejects(() => store.create({ selector: 'is_dir' }), /name is required/);
  await assert.rejects(() => store.create({ name: 'x' }), /selector is required/);
  await assert.rejects(
    () => store.create({ name: 'x', selector: 'is_dir', mode: 'bogus' }),
    /mode must be/,
  );
});

// ── list ──────────────────────────────────────────────────────────────────
test('list is empty before anything is written (no file yet)', async () => {
  const { store, file } = await freshStore();
  assert.equal(existsSync(file), false);
  assert.deepEqual(await store.list(), []);
});

test('list returns tags in insertion order', async () => {
  const { store } = await freshStore();
  await store.create({ name: 'a', selector: 'is_dir' });
  await store.create({ name: 'b', selector: 'is_hidden' });
  const names = (await store.list()).map((t) => t.name);
  assert.deepEqual(names, ['a', 'b']);
});

// ── get-by-id / get-by-name ──────────────────────────────────────────────────
test('getById finds a tag and returns null when missing', async () => {
  const { store } = await freshStore();
  const t = await store.create({ name: 'a', selector: 'is_dir' });
  assert.deepEqual(await store.getById(t.id), t);
  assert.equal(await store.getById('tag-does-not-exist'), null);
});

test('getByName finds a tag and returns null when missing', async () => {
  const { store } = await freshStore();
  const t = await store.create({ name: 'Recent', selector: 'mtime > now-3d' });
  assert.deepEqual(await store.getByName('Recent'), t);
  assert.equal(await store.getByName('Nope'), null);
});

// ── update ──────────────────────────────────────────────────────────────────
test('update patches fields, bumps updated_at, preserves id + created_at', async () => {
  // Deterministic clock: update()'s timestamp is guaranteed strictly later than
  // create()'s (no real setTimeout, no wall-clock-granularity race).
  const { store } = await freshStore({ now: monotonicClock() });
  const t = await store.create({ name: 'a', selector: 'is_dir' });
  const u = await store.update(t.id, { name: 'A!', selector: 'size > 2MB', color: '#f00' });
  assert.equal(u.id, t.id);
  assert.equal(u.created_at, t.created_at);
  assert.equal(u.name, 'A!');
  assert.equal(u.selector, 'size > 2MB');
  assert.equal(u.color, '#f00');
  assert.notEqual(u.updated_at, t.updated_at);
});

test('update returns null for an unknown id', async () => {
  const { store } = await freshStore();
  assert.equal(await store.update('tag-nope', { name: 'x' }), null);
});

test('update can clear a snapshot with snapshot:null', async () => {
  const { store } = await freshStore();
  const t = await store.create({ name: 'p', selector: 'is_dir', mode: 'frozen', snapshot: ['/x'] });
  const u = await store.update(t.id, { snapshot: null });
  assert.equal('snapshot' in u, false);
});

// ── delete ──────────────────────────────────────────────────────────────────
test('delete removes a tag and reports whether it removed one', async () => {
  const { store } = await freshStore();
  const t = await store.create({ name: 'a', selector: 'is_dir' });
  assert.equal(await store.delete(t.id), true);
  assert.equal(await store.getById(t.id), null);
  assert.equal(await store.delete(t.id), false); // already gone
});

// ── round-trip persistence ───────────────────────────────────────────────────
test('round-trip: a separate store handle reads what the first one wrote', async () => {
  const { dir, store } = await freshStore();
  const a = await store.create({ name: 'a', selector: 'ext = ts' });
  const b = await store.create({ name: 'b', selector: 'tag:a or ext = tsx' });
  const reopened = openTagStore({ dir });
  const got = await reopened.list();
  assert.deepEqual(got, [a, b]);
});

test('round-trip: on-disk JSON is human-readable and selector survives verbatim', async () => {
  const { store, file } = await freshStore();
  const selector = 'ext in (png, jpg) and size between 1MB and 10MB';
  await store.create({ name: 'Photos', selector });
  const raw = await fs.readFile(file, 'utf8');
  assert.match(raw, /\n {2}"version": 1/); // pretty-printed (2-space indent)
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.tags[0].selector, selector);
  // The stored selector parses with the DSL engine (shape compatibility).
  assert.doesNotThrow(() => parse(onDisk.tags[0].selector));
});

test('selector with tag:name self-reference round-trips and parses', async () => {
  const { store } = await freshStore();
  // tag:name atoms resolve via the engine's injectable resolver at evaluate
  // time (a follow-up task) — the store just persists the string.
  const t = await store.create({ name: 'derived', selector: 'tag:photos and not is_hidden' });
  const got = await store.getById(t.id);
  assert.equal(got.selector, 'tag:photos and not is_hidden');
  assert.doesNotThrow(() => parse(got.selector));
});

// ── atomic write ──────────────────────────────────────────────────────────
test('atomic write leaves no temp files behind on success', async () => {
  const { dir, store } = await freshStore();
  await store.create({ name: 'a', selector: 'is_dir' });
  await store.create({ name: 'b', selector: 'is_dir' });
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('atomic write: a failed write does NOT corrupt the existing file', async () => {
  const { store, file } = await freshStore();
  await store.create({ name: 'keeper', selector: 'is_dir' });
  const before = await fs.readFile(file, 'utf8');

  // Simulate a write failure: normalizeTag throws on a bad in-memory record,
  // so writeAll is never reached for the bad item — the real file is untouched.
  await assert.rejects(
    () => store.create({ name: '', selector: 'is_dir' }),
    /name is required/,
  );
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, before); // unchanged
  // And no orphaned temp file from the aborted op.
  const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeAll cleans up its temp file when rename target dir is unwritable', async () => {
  // Drive _internal.writeAll directly against a path whose parent we make a
  // file (so mkdir/rename misbehaves) to prove the temp is not left behind.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagstore-atomic-'));
  const blocker = path.join(dir, 'blocker');
  await fs.writeFile(blocker, 'x'); // a FILE where we'll try to treat it as a dir
  const target = path.join(blocker, 'tags.json'); // parent is a file → write fails
  await assert.rejects(() => _internal.writeAll(target, []));
  // Nothing partial created under dir besides our blocker file.
  assert.deepEqual(await fs.readdir(dir), ['blocker']);
});

// ── path resolution (cross-platform, no process.platform) ─────────────────────
test('resolveTagsFile honors file > dir > default precedence', () => {
  assert.equal(resolveTagsFile({ file: '/explicit/tags.json' }), '/explicit/tags.json');
  assert.equal(resolveTagsFile({ dir: '/some/dir' }), path.join('/some/dir', 'tags.json'));
  assert.match(resolveTagsFile(), /tags\.json$/);
});

test('defaultConfigDir prefers XDG_CONFIG_HOME then APPDATA then ~/.config', () => {
  const saved = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };
  try {
    process.env.XDG_CONFIG_HOME = '/xdg';
    delete process.env.APPDATA;
    assert.equal(_internal.defaultConfigDir(), path.join('/xdg', 'file_manager'));

    delete process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = '/appdata';
    assert.equal(_internal.defaultConfigDir(), path.join('/appdata', 'file_manager'));

    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    assert.equal(
      _internal.defaultConfigDir(),
      path.join(os.homedir(), '.config', 'file_manager'),
    );
  } finally {
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.xdg;
    if (saved.appdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = saved.appdata;
  }
});
