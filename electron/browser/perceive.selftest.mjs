// Pure-node self-test for perceive.mjs — NO browser, NO CDP (the supervisor
// does live testing). Feeds the parser hard-coded snapshot fixtures in the real
// `page.ariaSnapshot({mode:'ai'})` format and asserts node extraction, framePath
// derivation, attrs, parentRef; round-trips the ref map through a scratch
// BREEZE_MEMORY_DIR; and drives resolveByRef() against a MOCK page across the
// map-missing / url-changed / unknown-ref / dead-ref-remap / dead-ref-fail paths.
//
// Run: `node electron/browser/perceive.selftest.mjs`  (exits 0 pass, 1 fail).

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point persistence at a scratch dir BEFORE importing perceive.mjs so runKey()/
// fieldRefsDir() resolve there and no real profile state is touched.
process.env.BREEZE_MEMORY_DIR = mkdtempSync(path.join(os.tmpdir(), 'perceive-selftest-'));
process.env.BREEZE_TYPEBUILD_TASK_ID = 'selftest-run';

const {
  parseSnapshot,
  framePathOf,
  refsFromNodes,
  saveRefMap,
  loadRefMap,
  hasRefMap,
  snapshotSha1,
  resolveByRef,
  INTERACTIVE_ROLES,
} = await import('./perceive.mjs');

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log('  ok  - ' + msg);
  } else {
    failures++;
    console.error('  FAIL- ' + msg);
  }
}
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
async function throwsWith(fn, expected, msg) {
  try {
    await fn();
    ok(false, `${msg} — expected throw "${expected}" but none thrown`);
  } catch (e) {
    ok(e.message === expected, `${msg} — message: ${JSON.stringify(e.message)}`);
  }
}

// ── Fixture: a login page with a heading, plain text, textboxes with a
//    placeholder, a link with /url + cursor, a button, and an inlined iframe
//    whose interactive nodes carry frame-scoped refs (f1eN).
const FIXTURE = `- main [ref=e2]:
  - heading "Sign In" [level=1] [ref=e3]
  - text: Please log in to continue
  - textbox "User ID" [ref=e35]:
    - /placeholder: Enter your user ID.
  - textbox "Password" [ref=e36]
  - link "Forgot password?" [ref=e40] [cursor=pointer]:
    - /url: https://example.com/forgot
  - button "Log In" [ref=e41]
  - checkbox "Remember me" [checked] [ref=e42]
  - iframe [ref=e50]:
    - textbox "Captcha code" [ref=f1e3]:
      - /placeholder: Type the code shown
    - button "Verify" [ref=f1e4]
`;

console.log('# parseSnapshot');
const nodes = parseSnapshot(FIXTURE);
const byRef = Object.fromEntries(nodes.map((n) => [n.ref, n]));

eq(nodes.length, 10, 'extracts all 10 ref-bearing nodes');
ok(!nodes.some((n) => !n.ref), 'no ref-less node leaked into the list');

// roles + names
eq(byRef.e3.role, 'heading', 'e3 role=heading');
eq(byRef.e3.name, 'Sign In', 'e3 name');
eq(byRef.e35.role, 'textbox', 'e35 role=textbox');
eq(byRef.e35.name, 'User ID', 'e35 name');

// attrs: bracket + slash lines, coercion
eq(byRef.e3.attrs.level, 1, 'heading level coerced to number 1');
eq(byRef.e35.attrs.placeholder, 'Enter your user ID.', 'e35 placeholder from /placeholder line');
eq(byRef.e40.attrs.url, 'https://example.com/forgot', 'e40 url from /url line');
eq(byRef.e40.attrs.cursor, 'pointer', 'e40 cursor=pointer bracket attr');
eq(byRef.e42.attrs.checked, true, 'checkbox [checked] coerced to true');

// framePath derivation
eq(byRef.e35.framePath, '', 'top-frame node has empty framePath');
eq(byRef.f1e3.framePath, 'f1', 'frame node f1e3 framePath=f1');
eq(byRef.f1e4.framePath, 'f1', 'frame node f1e4 framePath=f1');

// parentRef = nearest ref-bearing ancestor
eq(byRef.e35.parentRef, 'e2', 'e35 parent is main e2');
eq(byRef.e3.parentRef, 'e2', 'e3 parent is main e2');
eq(byRef.f1e3.parentRef, 'e50', 'f1e3 parent is iframe e50');
eq(byRef.f1e4.parentRef, 'e50', 'f1e4 parent is iframe e50');
eq(byRef.e2.parentRef, null, 'root main has null parentRef');

// textContent attaches plain text to nearest ref ancestor
ok(byRef.e2.textContent.includes('Please log in to continue'), 'plain text attached to main e2');

// framePathOf direct + nested
eq(framePathOf('e35'), '', 'framePathOf top');
eq(framePathOf('f1e3'), 'f1', 'framePathOf f1');
eq(framePathOf('f1f2e7'), 'f1f2', 'framePathOf nested f1f2');
eq(framePathOf('garbage'), null, 'framePathOf rejects non-ref');

// defensive: junk never throws
ok(Array.isArray(parseSnapshot('total nonsense\n  not a list\n')), 'junk input parses to array without throwing');
ok(parseSnapshot('').length === 0, 'empty input → no nodes');

console.log('# refsFromNodes');
const interactive = refsFromNodes(nodes);
const iRoles = interactive.map((n) => n.role).sort();
ok(!iRoles.includes('heading'), 'heading filtered out of interactive set');
ok(!iRoles.includes('main'), 'main (generic container) filtered out');
ok(interactive.some((n) => n.ref === 'e35'), 'textbox e35 kept');
ok(interactive.some((n) => n.ref === 'e40'), 'link e40 kept');
ok(interactive.some((n) => n.ref === 'f1e4'), 'frame button f1e4 kept');
ok(INTERACTIVE_ROLES.has('combobox'), 'INTERACTIVE_ROLES exported and populated');

console.log('# ref-map round-trip');
const URL = 'https://portal.example.com/login';
const saved = saveRefMap({ url: URL, refs: interactive, text: FIXTURE });
ok(hasRefMap(), 'hasRefMap true after save');
const loaded = loadRefMap();
eq(loaded.url, URL, 'map url round-trips');
eq(loaded.snapshotSha1, snapshotSha1(FIXTURE), 'snapshotSha1 stored + matches recompute');
ok(typeof loaded.savedAt === 'string', 'savedAt present');
ok(loaded.refs.every((r) => 'ref' in r && 'role' in r && 'name' in r && 'framePath' in r), 'each stored ref has the 4 fields only');
// NON-PHI: ensure no value-ish keys crept in
ok(loaded.refs.every((r) => Object.keys(r).length === 4), 'stored ref carries exactly ref/role/name/framePath (no values)');
eq(saved.refs.length, interactive.length, 'saved every interactive ref');

console.log('# resolveByRef');
// Mock page factory: url() returns `url`; ariaSnapshot() returns `snap`;
// locator(sel) returns a stub whose count() is dictated by `counts[sel]`
// (default 1 = live).
function mockPage({ url, snap = FIXTURE, counts = {} }) {
  return {
    url: () => url,
    ariaSnapshot: async () => snap,
    locator: (sel) => ({ _sel: sel, count: async () => (sel in counts ? counts[sel] : 1) }),
  };
}

// happy path: ref live on matching url
const r1 = await resolveByRef(mockPage({ url: URL }), 'e35');
eq(r1.ref, 'e35', 'resolve returns same ref when live');
eq(r1.remapped, false, 'not remapped on happy path');
eq(r1.locator._sel, 'aria-ref=e35', 'locator built with aria-ref selector');

// unknown ref
await throwsWith(
  () => resolveByRef(mockPage({ url: URL }), 'e999'),
  'unknown ref "e999" — re-run: fields',
  'unknown ref throws actionable error',
);

// url changed
await throwsWith(
  () => resolveByRef(mockPage({ url: 'https://portal.example.com/next' }), 'e35'),
  `page changed since fields ran (was ${URL}, now https://portal.example.com/next) — re-run: fields`,
  'url change throws actionable error',
);

// dead ref, exactly one (role,name,framePath) match in fresh snapshot → remap.
// Fresh snapshot renumbers User ID from e35 to e77; count(aria-ref=e35)=0.
const REMAP_SNAP = FIXTURE.replace('[ref=e35]', '[ref=e77]');
const remapped = await resolveByRef(
  mockPage({ url: URL, snap: REMAP_SNAP, counts: { 'aria-ref=e35': 0 } }),
  'e35',
);
eq(remapped.ref, 'e77', 'dead ref remapped to e77 by role+name+framePath');
eq(remapped.remapped, true, 'remapped flag set');
eq(remapped.locator._sel, 'aria-ref=e77', 'remapped locator points at new ref');

// dead ref, element truly gone (no match) → staleness error
const GONE_SNAP = FIXTURE.replace(/.*textbox "User ID".*\n(?:.*placeholder.*\n)?/, '');
await throwsWith(
  () => resolveByRef(mockPage({ url: URL, snap: GONE_SNAP, counts: { 'aria-ref=e35': 0 } }), 'e35'),
  `page changed since fields ran (was ${URL}, now ${URL}) — re-run: fields`,
  'dead ref with no match throws staleness error',
);

// requireFresh:false trusts the map (no liveness recheck) even when count is 0
const trusted = await resolveByRef(
  mockPage({ url: URL, counts: { 'aria-ref=e35': 0 } }),
  'e35',
  { requireFresh: false },
);
eq(trusted.ref, 'e35', 'requireFresh:false returns ref without liveness recheck');
eq(trusted.remapped, false, 'requireFresh:false never remaps');

// no map at all → run: fields
process.env.BREEZE_TYPEBUILD_TASK_ID = 'a-run-with-no-map';
await throwsWith(
  () => resolveByRef(mockPage({ url: URL }), 'e35'),
  'no field map for this run — run: fields',
  'missing map throws run:fields error',
);
process.env.BREEZE_TYPEBUILD_TASK_ID = 'selftest-run';

console.log('');
if (failures) {
  console.error(`FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASSED: all assertions green');
process.exit(0);
