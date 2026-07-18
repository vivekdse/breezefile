#!/usr/bin/env node
// ─── FIXTURE STATIC VALIDATOR (no browser, no network) ──────────────────────
//
// Pure-node structural check over the fixture HTML in this directory. It never
// launches a browser or touches CDP — it only reads files and asserts, so it is
// always safe to run (unlike run-fixture-tests.mjs, which drives the SHARED
// operator page and is gated behind --yes).
//
// For every *.html fixture it asserts:
//   1. a non-empty <title> is present
//   2. an "EXPECTED OUTCOMES" declaration comment is present at the top
//   3. every aria-controls="ID" resolves to an element with that id IN THE SAME
//      FILE — the id may be declared statically (id="ID") OR assigned in the
//      fixture's own inline JS (`el.id = 'ID'`), since some fixtures build their
//      portal listbox at runtime
//   4. NO http(s):// reference appears anywhere (fixtures must be file://-pure)
//   5. every <iframe src="FILE"> points at a file that exists in this directory
//
// Exit 0 = all fixtures valid; exit 1 = one or more failures (details printed).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function htmlFiles() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.html'))
    .sort();
}

// An id "resolves" if it is declared as a static attribute OR assigned in JS.
function idExists(src, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\bid\\s*=\\s*["']${esc}["']`),        // <el id="X">
    new RegExp(`\\.id\\s*=\\s*["']${esc}["']`),          // el.id = 'X'
    new RegExp(`\\bid\\s*=\\s*["']${esc}["']`, 'i'),
  ];
  return patterns.some((re) => re.test(src));
}

function checkFile(file) {
  const src = readFileSync(path.join(DIR, file), 'utf8');
  const errors = [];

  // 1. title
  const titleMatch = src.match(/<title>([^<]*)<\/title>/i);
  if (!titleMatch || !titleMatch[1].trim()) {
    errors.push('missing or empty <title>');
  }

  // 2. expected-outcomes comment
  if (!/EXPECTED OUTCOMES/.test(src)) {
    errors.push('missing "EXPECTED OUTCOMES" declaration comment');
  }
  if (!/^\s*<!--/.test(src)) {
    errors.push('top-of-file declaration comment not found at start of file');
  }

  // 3. aria-controls resolves
  const controlsRe = /aria-controls\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = controlsRe.exec(src)) !== null) {
    // aria-controls may list multiple space-separated ids.
    for (const id of m[1].trim().split(/\s+/)) {
      if (!idExists(src, id)) {
        errors.push(`aria-controls="${id}" has no matching element id in this file`);
      }
    }
  }

  // 4. no http(s):// references
  const urlMatches = src.match(/https?:\/\/[^\s"'<>)]+/gi);
  if (urlMatches) {
    errors.push(`found ${urlMatches.length} http(s):// reference(s): ${[...new Set(urlMatches)].join(', ')}`);
  }

  // 5. iframe src files exist
  const iframeRe = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = iframeRe.exec(src)) !== null) {
    const target = m[1];
    if (/^https?:/i.test(target)) continue; // caught by rule 4
    const resolved = path.join(DIR, target);
    if (!existsSync(resolved)) {
      errors.push(`<iframe src="${target}"> points at a missing file`);
    }
  }

  return errors;
}

function main() {
  const files = htmlFiles();
  if (files.length === 0) {
    console.error('no .html fixtures found');
    process.exit(1);
  }
  let failed = 0;
  for (const file of files) {
    const errors = checkFile(file);
    if (errors.length === 0) {
      console.log(`PASS  ${file}`);
    } else {
      failed++;
      console.log(`FAIL  ${file}`);
      for (const e of errors) console.log(`        - ${e}`);
    }
  }
  console.log('');
  console.log(`${files.length - failed}/${files.length} fixtures valid`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
