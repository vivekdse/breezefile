// install-runtime HELPERS closure guard.
//
// installAutomation() (electron/browser/install-runtime.mjs) copies the
// HELPERS manifest into ~/.breezefile/automation. Relative imports resolve at
// the DESTINATION, so any module a helper imports that isn't itself in the
// manifest installs a runtime that dies with ERR_MODULE_NOT_FOUND the first
// time a user runs breeze-tools or the browser cli — exactly the drift this
// test exists to catch (net.mjs / api-spec.mjs / param-bindings.mjs /
// promote.mjs were once imported but unlisted).
//
// Approach: statically parse the HELPERS array out of install-runtime.mjs,
// then walk the relative-import graph from every listed file and assert the
// closure is a subset of the manifest. Static text parsing (not import()) so
// the test never executes the installer or touches $HOME.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = path.join(repoRoot, 'electron', 'browser', 'install-runtime.mjs');

/** Extract HELPERS entries (['a','b.mjs'] tuples) from the installer source. */
function parseHelpers(src) {
  const m = src.match(/const HELPERS = \[([\s\S]*?)\];/);
  assert.ok(m, 'HELPERS array not found in install-runtime.mjs');
  const entries = [...m[1].matchAll(/\[([^\]]+)\]/g)].map((tuple) =>
    [...tuple[1].matchAll(/'([^']+)'/g)].map((q) => q[1]),
  );
  assert.ok(entries.length > 0, 'HELPERS parsed empty');
  return entries.map((parts) => parts.join('/'));
}

/** All relative import/export-from specifiers in a module's source. */
function relativeImports(src) {
  return [...src.matchAll(/(?:import|export)[^'"]*?from\s+'(\.{1,2}\/[^']+)'/g)].map(
    (m) => m[1],
  );
}

test('HELPERS manifest covers the full relative-import closure', () => {
  const manifest = new Set(parseHelpers(readFileSync(installerPath, 'utf8')));
  const missing = [];
  const seen = new Set();
  const queue = [...manifest];

  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(repoRoot, rel);
    const src = readFileSync(abs, 'utf8'); // throws → listed file missing from repo
    for (const spec of relativeImports(src)) {
      const resolved = path
        .normalize(path.join(path.dirname(rel), spec))
        .split(path.sep)
        .join('/');
      if (!manifest.has(resolved)) missing.push(`${rel} imports ${resolved}`);
      else if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `modules imported by installed helpers but absent from HELPERS (would ERR_MODULE_NOT_FOUND at the install destination):\n  ${missing.join('\n  ')}`,
  );
});
