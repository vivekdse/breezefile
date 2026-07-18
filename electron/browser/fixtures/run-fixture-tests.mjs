#!/usr/bin/env node
// ─── FIELD-PERCEPTION FIXTURE TEST HARNESS (drives the REAL CLI) ─────────────
//
// This runner shells out to the actual operator-browser CLI
// (../cli.mjs) as SUBPROCESSES — `node ../cli.mjs <verb> [args...]` — with the
// current env passed through (BREEZE_CDP_URL, BREEZE_BROWSER_TARGET, etc.). It
// navigates the browser to each fixture via `goto file://…` and asserts on the
// verb stdout. It exercises the CLI exactly as an agent would, end to end.
//
// ⚠️  SAFETY — READ THIS. This runner DRIVES THE SHARED OPERATOR PAGE. There is
//     ONE operator browser page and a live supervisor may be using it. Running
//     this navigates that page away to the fixtures. Therefore the runner is
//     SAFE-BY-DEFAULT: it REFUSES to run unless you pass --yes. After a run the
//     operator page is LEFT ON THE LAST FIXTURE it navigated to (it does not
//     restore the prior URL) — re-point it yourself if a human was mid-task.
//
// Usage:
//   node run-fixture-tests.mjs --list              # print cases, run NOTHING
//   node run-fixture-tests.mjs --yes               # run all (requires --yes)
//   node run-fixture-tests.mjs --yes --only title-native-select
//   node run-fixture-tests.mjs --only foo          # (without --yes) still lists only
//
// Exit code: 0 = all selected cases passed; 1 = a failure or a refusal.
//
// Case shape (declarative):
//   { name, fixture, steps: [ { verb, args, expectStdoutMatches, expectExitCode } ] }
//     - verb                : CLI verb (goto|title|snapshot|text|…)
//     - args                : array of positional args (fixture file URL is
//                             substituted for the literal token "$FIXTURE_URL")
//     - expectStdoutMatches : RegExp | string | array of them, ALL must match
//                             (substring for string, .test() for RegExp)
//     - expectStdoutAbsent  : RegExp | string | array — NONE may match (used for
//                             the iframe frame-scope / broken-aria negative paths)
//     - expectExitCode      : expected process exit code (default 0)
//
// The CLI appends a trailing `[timing] …` line to every verb's stdout, so
// matchers use substring/regex CONTAINMENT, never full-output equality.

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(DIR, '..', 'cli.mjs');

function fixtureUrl(file) {
  return pathToFileURL(path.join(DIR, file)).href;
}

// ── ACTIVE CASES — seeded to work against the CLI AS IT EXISTS TODAY ─────────
// (goto / title / snapshot / text only). These pass with today's verbs; they do
// NOT depend on the not-yet-built field-perception layer.
const CASES = [
  // 1. native-select ────────────────────────────────────────────────────────
  {
    name: 'title-native-select',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to file:.*native-select\.html/ },
      { verb: 'title', args: [], expectStdoutMatches: 'native-select' },
    ],
  },
  {
    name: 'snapshot-native-select-labels',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      // The visible field labels must show up in today's ariaSnapshot.
      { verb: 'snapshot', args: [], expectStdoutMatches: ['State', 'Provider', 'Member ID'] },
    ],
  },

  // 2. combobox-static ───────────────────────────────────────────────────────
  {
    name: 'title-combobox-static',
    fixture: 'combobox-static.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'combobox-static' },
    ],
  },
  {
    name: 'snapshot-combobox-static-label',
    fixture: 'combobox-static.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      // Label present; the combobox role is exposed on the input.
      { verb: 'snapshot', args: [], expectStdoutMatches: ['Diagnosis', 'combobox'] },
    ],
  },

  // 3. autocomplete-async ────────────────────────────────────────────────────
  {
    name: 'title-autocomplete-async',
    fixture: 'autocomplete-async.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'autocomplete-async' },
    ],
  },
  {
    name: 'snapshot-autocomplete-async-label',
    fixture: 'autocomplete-async.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'snapshot', args: [], expectStdoutMatches: ['Patient', 'combobox'] },
    ],
  },

  // 4. virtualized ───────────────────────────────────────────────────────────
  {
    name: 'title-virtualized',
    fixture: 'virtualized.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'virtualized' },
    ],
  },
  {
    name: 'snapshot-virtualized-label',
    fixture: 'virtualized.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'snapshot', args: [], expectStdoutMatches: ['Procedure code', 'listbox'] },
    ],
  },

  // 5. iframe-form ── FRAME-SCOPE / STALENESS marker ─────────────────────────
  {
    name: 'title-iframe-form',
    fixture: 'iframe-form.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'iframe-form' },
    ],
  },
  {
    name: 'iframe-inner-content-absent-today',
    fixture: 'iframe-form.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      // Top-frame label IS present today…
      { verb: 'snapshot', args: [], expectStdoutMatches: 'Case number',
        // …but the INNER / INNERMOST iframe labels are NOT — the CLI's `loc` runs
        // against the top document only. This asserts that absence.
        // TODO(field-perception-layer): when the layer descends frames, FLIP the
        // two labels below from expectStdoutAbsent to expectStdoutMatches (and
        // add "Authorization PIN") — that is the acceptance test for frame descent.
        expectStdoutAbsent: ['Diagnosis note', 'Priority', 'Authorization PIN'] },
    ],
  },

  // 6. broken-aria ── NEGATIVE path (div-soup has no a11y semantics) ──────────
  {
    name: 'title-broken-aria',
    fixture: 'broken-aria.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'broken-aria' },
    ],
  },
  {
    name: 'broken-aria-no-listbox-role',
    fixture: 'broken-aria.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      // The div-soup control exposes NO combobox/listbox/option roles. The
      // visible trigger text is still readable via `text`.
      { verb: 'snapshot', args: [], expectStdoutAbsent: [/\blistbox\b/, /\boption\b/, /\bcombobox\b/] },
      { verb: 'text', args: [], expectStdoutMatches: 'Determination' },
    ],
  },

  // 7. navigating ── staleness / title-flip across navigation ────────────────
  {
    name: 'title-navigating-step1',
    fixture: 'navigating.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'step 1 of 2' },
    ],
  },
  // Direct load of step 2 (no click needed) proves the step-2 title text; the
  // click-driven transition is exercised by the PENDING case below once a
  // settle/wait verb for post-click navigation is standardized.
  {
    name: 'title-navigating-step2-direct',
    fixture: 'navigating-step2.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'title', args: [], expectStdoutMatches: 'step 2 of 2' },
    ],
  },
];

// ── PENDING CASES (skeleton) — the FUTURE field-perception verbs ────────────
// These are NOT run today; they document the acceptance tests the new layer must
// pass. Un-comment + move into CASES as each verb (`fields`, `field`,
// `field-select`, `field-fill`) lands. Left commented so the runner stays green
// against today's CLI.
//
// const PENDING_CASES = [
//   {
//     name: 'PENDING fields-enumerates-native-select',
//     fixture: 'native-select.html',
//     steps: [
//       { verb: 'goto',   args: ['$FIXTURE_URL'] },
//       // `fields` should classify: State→native-select(8), Provider→native-select
//       // (10000, NOT enumerated), Member ID→text.
//       { verb: 'fields', args: [], expectStdoutMatches: ['native-select', '10000', 'text'] },
//     ],
//   },
//   {
//     name: 'PENDING field-select-small-native-by-label',
//     fixture: 'native-select.html',
//     steps: [
//       { verb: 'goto',         args: ['$FIXTURE_URL'] },
//       // field-select <ref-of-State> --pick "Texas"  => commits value "TX".
//       { verb: 'field-select', args: ['<STATE_REF>', '--pick', 'Texas'] },
//       // Read-back receipt via the committed-value readout:
//       { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'State = TX (Texas)' },
//     ],
//   },
//   {
//     name: 'PENDING field-select-huge-native-by-query',
//     fixture: 'native-select.html',
//     steps: [
//       { verb: 'goto',         args: ['$FIXTURE_URL'] },
//       // --query narrows the 10000-option select WITHOUT enumerating them.
//       { verb: 'field-select', args: ['<PROVIDER_REF>', '--query', '00042', '--pick', 'Provider 00042 — Specialty B'] },
//       { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'P00042' },
//     ],
//   },
//   {
//     name: 'PENDING field-select-combobox-static',
//     fixture: 'combobox-static.html',
//     steps: [
//       { verb: 'goto',         args: ['$FIXTURE_URL'] },
//       { verb: 'field-select', args: ['<COMBO_REF>', '--query', 'Condition 07', '--pick', 'Condition 07'] },
//       { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Diagnosis = Condition 07' },
//     ],
//   },
//   {
//     name: 'PENDING field-select-async-waits-for-status',
//     fixture: 'autocomplete-async.html',
//     steps: [
//       { verb: 'goto',         args: ['$FIXTURE_URL'] },
//       // Must debounce+await the role=status "3 results available." before picking.
//       { verb: 'field-select', args: ['<PATIENT_REF>', '--query', 'ram', '--pick', 'Ramachandran, Arun'] },
//       { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Ramachandran, Arun' },
//     ],
//   },
//   {
//     name: 'PENDING field-select-virtualized-arrow-fallback',
//     fixture: 'virtualized.html',
//     steps: [
//       { verb: 'goto',         args: ['$FIXTURE_URL'] },
//       // No full enumeration possible — arrow-through fallback to "Code 0004".
//       { verb: 'field-select', args: ['<PROC_REF>', '--pick', 'Code 0004'] },
//       { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Code 0004' },
//     ],
//   },
//   {
//     name: 'PENDING field-fill-iframe-descends-frames',
//     fixture: 'iframe-form.html',
//     steps: [
//       { verb: 'goto',   args: ['$FIXTURE_URL'] },
//       // fields must list all 4 across the 3 frames.
//       { verb: 'fields', args: [], expectStdoutMatches: ['Case number', 'Diagnosis note', 'Priority', 'Authorization PIN'] },
//     ],
//   },
//   {
//     name: 'PENDING field-select-broken-aria-degrades',
//     fixture: 'broken-aria.html',
//     steps: [
//       { verb: 'goto',   args: ['$FIXTURE_URL'] },
//       // The layer must REFUSE to claim a role=option enumeration here and
//       // report the control as div-soup / unknown.
//       { verb: 'fields', args: [], expectStdoutMatches: /unknown|div-soup|no accessible/i },
//     ],
//   },
//   {
//     name: 'PENDING field-select-stale-ref-fails-loud',
//     fixture: 'navigating.html',
//     steps: [
//       { verb: 'goto',  args: ['$FIXTURE_URL'] },
//       // Capture a step-1 ref, click Continue (DOM replaced + navigation), then
//       // acting on the stale ref MUST fail (non-zero), not silently mis-target.
//       { verb: 'field', args: ['<STALE_REF>'], expectExitCode: 1, expectStdoutMatches: /stale|not found|re-?snapshot/i },
//     ],
//   },
// ];

// ── engine ──────────────────────────────────────────────────────────────────

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function matches(hay, matcher) {
  if (matcher instanceof RegExp) return matcher.test(hay);
  return hay.includes(String(matcher));
}

function runStep(fixture, step) {
  const args = (step.args || []).map((a) =>
    a === '$FIXTURE_URL' ? fixtureUrl(fixture) : a,
  );
  const res = spawnSync('node', [CLI, step.verb, ...args], {
    cwd: DIR,
    env: process.env, // passthrough: BREEZE_CDP_URL, BREEZE_BROWSER_TARGET, …
    encoding: 'utf8',
    timeout: 60000,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const exitCode = res.status === null ? -1 : res.status;
  const failures = [];

  const expectedExit = step.expectExitCode ?? 0;
  if (exitCode !== expectedExit) {
    failures.push(`exit code ${exitCode} (expected ${expectedExit})` +
      (stderr ? ` — stderr: ${stderr.trim().split('\n')[0]}` : ''));
  }
  for (const m of asArray(step.expectStdoutMatches)) {
    if (!matches(stdout, m)) failures.push(`stdout did not match ${m}`);
  }
  for (const m of asArray(step.expectStdoutAbsent)) {
    if (matches(stdout, m)) failures.push(`stdout unexpectedly matched (should be ABSENT) ${m}`);
  }
  return { failures, stdout, stderr, exitCode };
}

function runCase(c) {
  process.stdout.write(`\n▶ ${c.name}  [${c.fixture}]\n`);
  let ok = true;
  for (const step of c.steps) {
    const label = `${step.verb} ${(step.args || []).join(' ')}`.trim();
    const r = runStep(c.fixture, step);
    if (r.failures.length === 0) {
      process.stdout.write(`    ✓ ${label}\n`);
    } else {
      ok = false;
      process.stdout.write(`    ✗ ${label}\n`);
      for (const f of r.failures) process.stdout.write(`        ${f}\n`);
    }
  }
  return ok;
}

function parseArgv(argv) {
  const flags = { list: false, yes: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') flags.list = true;
    else if (argv[i] === '--yes') flags.yes = true;
    else if (argv[i] === '--only') flags.only = argv[++i];
  }
  return flags;
}

function main() {
  const flags = parseArgv(process.argv.slice(2));
  let cases = CASES;
  if (flags.only) cases = cases.filter((c) => c.name.includes(flags.only));

  if (flags.list) {
    process.stdout.write('Fixture test cases (run NOTHING; --list):\n\n');
    for (const c of cases) {
      process.stdout.write(`  ${c.name}  [${c.fixture}]\n`);
      for (const s of c.steps) {
        process.stdout.write(`      - ${s.verb} ${(s.args || []).join(' ')}\n`);
      }
    }
    process.stdout.write(`\n${cases.length} case(s). Pass --yes to actually run them ` +
      `(drives the SHARED operator page).\n`);
    process.exit(0);
  }

  if (!flags.yes) {
    process.stderr.write(
      'REFUSING TO RUN.\n' +
      'This runner drives the SHARED operator browser page (there is one page, a\n' +
      'live supervisor may be using it) and leaves it on the last fixture.\n' +
      'Re-run with --yes to confirm, or --list to see the cases without running.\n',
    );
    process.exit(1);
  }

  if (cases.length === 0) {
    process.stderr.write(`no cases matched --only "${flags.only}"\n`);
    process.exit(1);
  }

  process.stdout.write(`Running ${cases.length} fixture case(s) against ${CLI}\n`);
  let passed = 0;
  for (const c of cases) {
    if (runCase(c)) passed++;
  }
  const failed = cases.length - passed;
  process.stdout.write(`\n${'─'.repeat(50)}\n`);
  process.stdout.write(`${passed}/${cases.length} case(s) passed` +
    (failed ? `, ${failed} FAILED` : '') + '.\n');
  process.stdout.write('NOTE: the operator page is left on the last fixture navigated to.\n');
  process.exit(failed === 0 ? 0 : 1);
}

main();
