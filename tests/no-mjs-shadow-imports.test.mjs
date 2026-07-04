// Guard against the "pure-logic split" shadow-import hazard.
//
// Pattern used across this repo: `foo.ts` (wrapper, may re-export a class /
// side-effecting API) + `foo.mjs` (pure helpers only) + `foo.d.mts` (types
// for the .mjs). An extensionless relative import of `./foo` resolves to
// `foo.ts` under tsc (typecheck GREEN) but to the `foo.mjs` shadow under
// Vite/esbuild's module resolution (which prefers `.mjs`/`.js` over `.ts`
// for extensionless specifiers) — silently dropping the wrapper's exports
// at runtime ("does not provide an export of ...") and blanking the app.
//
// This shipped once in 6e3d9e2 (NewHomePage -> selectedProjectPrefs), passed
// every existing test + typecheck, and was hotfixed in c7ca051 by importing
// './selectedProjectPrefs.ts' explicitly. This test prevents a repeat: it
// scans src/ and electron/ for extensionless relative imports that resolve
// to a module with BOTH a `<name>.mjs` and a `<name>.ts`/`.tsx` sibling, and
// fails naming the offending file + import specifier.
//
// See task-bbeed2be17fb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = ['src', 'electron'];
const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git']);

// Matches `from '...'` / `from "..."` and `import('...')`/`import("...")`
// specifiers, relative-only (starts with './' or '../').
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

/**
 * Walk a directory recursively, yielding absolute file paths.
 */
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

/**
 * Extract relative import specifiers from a source file's text.
 */
export function extractRelativeImports(text) {
  const specifiers = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(text)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Given the directory of the importing file and a relative specifier,
 * determine whether the specifier is "extensionless" (no recognized source
 * extension) and, if so, whether the resolved base path has BOTH a `.mjs`
 * and a `.ts`/`.tsx` sibling — the shadow hazard.
 *
 * Returns null if the specifier is not a hazard; otherwise an object
 * describing the hazard.
 */
export function checkImportForShadowHazard(importerDir, specifier, existsSync = fs.existsSync) {
  const KNOWN_EXTS = ['.ts', '.tsx', '.mjs', '.js', '.mts', '.cjs', '.json'];
  if (KNOWN_EXTS.some((ext) => specifier.endsWith(ext))) {
    return null; // already explicit
  }

  const resolvedBase = path.normalize(path.join(importerDir, specifier));

  const mjsExists = existsSync(resolvedBase + '.mjs');
  if (!mjsExists) return null;

  const tsExists = existsSync(resolvedBase + '.ts');
  const tsxExists = existsSync(resolvedBase + '.tsx');
  if (!tsExists && !tsxExists) return null;

  return {
    specifier,
    resolvedBase,
    shadowExt: tsExists ? '.ts' : '.tsx',
  };
}

/**
 * Scan a list of root directories (relative to repoRoot) for source files
 * and return all shadow-hazard findings.
 */
export function scanForShadowHazards(repoRoot, scanDirs, existsSync = fs.existsSync) {
  const findings = [];
  for (const rel of scanDirs) {
    const dir = path.join(repoRoot, rel);
    for (const file of walk(dir)) {
      const ext = path.extname(file);
      if (!SOURCE_EXTS.has(ext)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const importerDir = path.dirname(file);
      for (const specifier of extractRelativeImports(text)) {
        const hazard = checkImportForShadowHazard(importerDir, specifier, existsSync);
        if (hazard) {
          findings.push({ file, ...hazard });
        }
      }
    }
  }
  return findings;
}

test('no extensionless relative import resolves to a .mjs-shadowed module (src/ + electron/)', () => {
  const findings = scanForShadowHazards(REPO_ROOT, SCAN_DIRS);
  if (findings.length > 0) {
    const details = findings
      .map(
        (f) =>
          `  ${path.relative(REPO_ROOT, f.file)}: import '${f.specifier}' resolves to ` +
          `'${path.relative(REPO_ROOT, f.resolvedBase)}' which has BOTH .mjs and ${f.shadowExt} ` +
          `siblings — use the explicit '${f.specifier}${f.shadowExt}' extension`,
      )
      .join('\n');
    assert.fail(
      `Found ${findings.length} extensionless import(s) shadowed by a sibling .mjs file. ` +
        `tsc resolves these to .ts (typecheck green) but Vite/esbuild resolve to .mjs at ` +
        `runtime, dropping the wrapper's exports (see task-bbeed2be17fb, commits 6e3d9e2/c7ca051):\n${details}`,
    );
  }
  assert.equal(findings.length, 0);
});

test('self-test: checker catches a synthetic shadow-hazard offender (in-memory fixture)', () => {
  // Simulate a directory that has both `foo.mjs` and `foo.ts` next to an
  // importer that does `from './foo'` (extensionless) — the exact shape of
  // the 6e3d9e2 regression, without touching any real app file.
  const fakeExistingPaths = new Set([
    '/fake/repo/src/widgets/foo.mjs',
    '/fake/repo/src/widgets/foo.ts',
  ]);
  const fakeExistsSync = (p) => fakeExistingPaths.has(path.normalize(p));

  const hazard = checkImportForShadowHazard('/fake/repo/src/widgets', './foo', fakeExistsSync);
  assert.ok(hazard, 'expected the extensionless import of a .mjs+.ts shadowed module to be flagged');
  assert.equal(hazard.shadowExt, '.ts');
  assert.equal(path.normalize(hazard.resolvedBase), path.normalize('/fake/repo/src/widgets/foo'));

  // And a full-scan-shaped check via extractRelativeImports + the same fixture:
  const sourceText = `import { bar } from './foo';\nimport('./foo').then(() => {});\n`;
  const specifiers = extractRelativeImports(sourceText);
  assert.deepEqual(specifiers, ['./foo', './foo']);
  for (const spec of specifiers) {
    const found = checkImportForShadowHazard('/fake/repo/src/widgets', spec, fakeExistsSync);
    assert.ok(found, `expected specifier '${spec}' to be flagged as a shadow hazard`);
  }

  // Negative control: explicit .ts extension must NOT be flagged.
  const explicitHazard = checkImportForShadowHazard('/fake/repo/src/widgets', './foo.ts', fakeExistsSync);
  assert.equal(explicitHazard, null, 'explicit .ts import must not be flagged');

  // Negative control: extensionless import with no .mjs sibling must NOT be flagged.
  const noShadowPaths = new Set(['/fake/repo/src/widgets/bar.ts']);
  const noShadowExists = (p) => noShadowPaths.has(path.normalize(p));
  const noHazard = checkImportForShadowHazard('/fake/repo/src/widgets', './bar', noShadowExists);
  assert.equal(noHazard, null, 'extensionless import with no .mjs shadow must not be flagged');
});
