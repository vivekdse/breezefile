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
//     - expectStderrMatches : RegExp | string | array — ALL must match against
//                             stderr (for verbs that report via stderr, e.g. the
//                             unknown-verb guard's suggestion)
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

  // ── FIELD PERCEPTION (phase 2) — the `page` / `fields` / `field` verbs ──────
  //
  // These drive the real perception layer end to end. Aria refs are HARDCODED
  // (e5/e8/e11, e4, …): they are deterministic for a fixed fixture DOM (assigned
  // in AX-tree document order) and each case re-runs `goto`+`fields` first so the
  // ref map is minted for this runner process (shared ppid => shared runKey)
  // before any `field` step resolves against it.

  // 8. fields enumerates a native-select page (small select, HUGE select w/ its
  //    option count, text input) WITHOUT dumping option bodies.
  {
    name: 'fields-native-select',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [],
        expectStdoutMatches: ['fields (3)', 'State', 'Provider', 'Member ID',
          'select', 'text', 'options:10001', '→ inspect: field <ref>'],
        // the 10001 options are NEVER dumped into the fields listing.
        expectStdoutAbsent: [/Provider 00500/, /Provider 09999/] },
    ],
  },

  // 9. field on the 10k select: capped at 50 (option bodies far down are ABSENT),
  //    and --filter narrows the FULL list to the one match without a 10k dump.
  {
    name: 'field-native-huge-capped-and-filtered',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: /fields \(/ },
      // unfiltered: kind select, capped receipt present, deep options ABSENT.
      { verb: 'field', args: ['e8'],
        expectStdoutMatches: ['"kind": "select"', 'showing 50 of 10001', 'Provider 00001'],
        expectStdoutAbsent: [/Provider 05000/, /Provider 09999/] },
      // --filter resolves the single match without enumerating the rest.
      { verb: 'field', args: ['e8', '--filter', '00042'],
        expectStdoutMatches: ['"kind": "select"', 'Provider 00042', '10001'],
        expectStdoutAbsent: [/Provider 00500/, /Provider 09999/] },
    ],
  },

  // 10. field on a STATIC custom combobox: species refined to combobox-static,
  //     options harvested by opening — and the probe is SIDE-EFFECT-SAFE (the
  //     committed-value readout is unchanged afterward).
  {
    name: 'field-combobox-static-side-effect-safe',
    fixture: 'combobox-static.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Diagnosis' },
      { verb: 'field', args: ['e4'],
        expectStdoutMatches: ['"kind": "combobox-static"', 'Condition 07', 'field-select e4 --pick'] },
      // readout untouched by the open/close probe.
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'committed value: (none)' },
    ],
  },

  // 11. field on an ASYNC autocomplete: species refined to combobox-async, no
  //     option harvest (must not type), optionsHint points at --query.
  {
    name: 'field-combobox-async',
    fixture: 'autocomplete-async.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Patient' },
      { verb: 'field', args: ['e4'],
        expectStdoutMatches: ['"kind": "combobox-async"', 'async — options come from typing',
          '--query'],
        expectStdoutAbsent: [/"options": \[/] },
    ],
  },

  // 12. fields across NESTED IFRAMES: all 4 fields, each non-top one carrying its
  //     [frame fN] marker (frames number FLAT: f1, f2).
  {
    name: 'fields-iframe-descends-frames',
    fixture: 'iframe-form.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [],
        expectStdoutMatches: ['fields (4)', 'Case number', 'Diagnosis note', 'Priority',
          'Authorization PIN', '[frame f1]', '[frame f2]'] },
    ],
  },

  // 13. broken (div-soup) page: NO ARIA field semantics => fields degrades with an
  //     escape-hatch pointer, never claims an option enumeration.
  {
    name: 'fields-broken-aria-escape-hatch',
    fixture: 'broken-aria.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [],
        expectStdoutMatches: [/no accessible fields/i, /net-observe/],
        expectStdoutAbsent: [/\boption\b/, /\blistbox\b/] },
    ],
  },

  // 14. STALENESS: capture a step-1 ref, click Continue (DOM replace + navigate),
  //     then `field <ref>` surfaces perceive.mjs's 'page changed … re-run: fields'
  //     text on stdout and exits non-zero — never silently mis-targets.
  {
    name: 'field-stale-ref-after-navigation',
    fixture: 'navigating.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Applicant name' },
      { verb: 'click', args: ['#continue'], expectStdoutMatches: /clicked/ },
      { verb: 'field', args: ['e4'], expectExitCode: 1,
        expectStdoutMatches: [/page changed/, /re-run: fields/] },
    ],
  },

  // ── FIELD ACTIONS (phase 3) — the ref-based SETTERS field-fill/field-select ─
  // Activated from the former PENDING skeleton. Refs are the ones `fields` mints
  // for each fixture (State e5 / Provider e8 / Member ID e11; Diagnosis e4;
  // Patient e4; Procedure code e4; Authorization PIN f2e3). Each case re-runs
  // goto+fields first (shared runner ppid ⇒ shared ref map) before the setter
  // resolves. Receipts are verified BOTH via the setter's own stdout AND, where
  // the fixture exposes one, its #committed-readout (the page's source of truth).

  // 15. native select happy path: --pick "Texas" commits value TX; receipt +
  //     readout both prove the commit.
  {
    name: 'field-select-native-small-happy',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'State' },
      { verb: 'field-select', args: ['e5', '--pick', 'Texas'],
        expectStdoutMatches: 'selected "Texas" = "Texas"' },
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'State = TX (Texas)' },
    ],
  },

  // 16. 10k native select resolved by a SUBSTRING --pick — matched against the
  //     full option list WITHOUT the 10001 options ever being dumped.
  {
    name: 'field-select-native-huge-by-substring',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Provider' },
      // "Provider 00042" is a unique substring of "Provider 00042 — Specialty C".
      { verb: 'field-select', args: ['e8', '--pick', 'Provider 00042'],
        expectStdoutMatches: ['selected "Provider 00042"', 'Provider 00042'],
        expectStdoutAbsent: [/Provider 05000/, /Provider 09999/] },
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'P00042' },
    ],
  },

  // 17. STATIC custom combobox: open + harvest the portal listbox, --pick by
  //     exact label, dispatch-click commits it.
  {
    name: 'field-select-combobox-static',
    fixture: 'combobox-static.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Diagnosis' },
      { verb: 'field-select', args: ['e4', '--pick', 'Condition 07'],
        expectStdoutMatches: 'selected "Condition 07" = "Condition 07"' },
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Diagnosis = Condition 07' },
    ],
  },

  // 18. ASYNC autocomplete: --query types with per-key delay, the reader WAITS
  //     for "N results available." to settle, then --pick commits. Readout proves it.
  {
    name: 'field-select-async-query-settle',
    fixture: 'autocomplete-async.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Patient' },
      { verb: 'field-select', args: ['e4', '--query', 'ram', '--pick', 'Ramachandran, Anita'],
        expectStdoutMatches: 'selected "Ramachandran, Anita" = "Ramachandran, Anita"' },
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Patient = Ramachandran, Anita' },
    ],
  },

  // 19. ASYNC AMBIGUITY: --pick "Ramachandran" matches TWO options ⇒ candidates
  //     list + retry line + exit 1 (never silently commits the first).
  {
    name: 'field-select-async-ambiguous',
    fixture: 'autocomplete-async.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Patient' },
      { verb: 'field-select', args: ['e4', '--query', 'ram', '--pick', 'Ramachandran'],
        expectExitCode: 1,
        expectStdoutMatches: [/matched multiple options/, 'Ramachandran, Anita',
          'Ramachandran, Arun', /→ retry: field-select e4 --pick/] },
    ],
  },

  // 20. VIRTUALIZED listbox, shallow: "Code 0004" is 3 ArrowDowns from rest —
  //     arrow-walk aria-activedescendant + Enter (the full list is never in DOM).
  {
    name: 'field-select-virtualized-shallow',
    fixture: 'virtualized.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Procedure code' },
      { verb: 'field-select', args: ['e4', '--pick', 'Code 0004'],
        expectStdoutMatches: 'selected "Code 0004" = "Code 0004"' },
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Procedure code = Code 0004' },
    ],
  },

  // 21. VIRTUALIZED listbox, DEEP: "Code 0721" (index 720) must still be reachable
  //     by the arrow-walk — proves the 1000-option list is fully selectable.
  {
    name: 'field-select-virtualized-deep',
    fixture: 'virtualized.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Procedure code' },
      { verb: 'field-select', args: ['e4', '--pick', 'Code 0721'],
        expectStdoutMatches: 'selected "Code 0721" = "Code 0721"' },
      { verb: 'text', args: ['#committed-readout'], expectStdoutMatches: 'Procedure code = Code 0721' },
    ],
  },

  // 22. REFUSAL: field-select on a TEXT field points at field-fill + exits 1 —
  //     never guesses a "select" on a free-text control.
  {
    name: 'field-select-on-text-refuses',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Member ID' },
      { verb: 'field-select', args: ['e11', '--pick', 'anything'], expectExitCode: 1,
        expectStdoutMatches: [/"Member ID" is text/, /field-fill e11/] },
    ],
  },

  // 23. field-fill reaches a TEXT input inside a nested iframe by ref and reads
  //     the committed value back into its receipt.
  {
    name: 'field-fill-iframe-text',
    fixture: 'iframe-form.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Authorization PIN' },
      { verb: 'field-fill', args: ['f2e3', '1234'],
        expectStdoutMatches: 'filled "Authorization PIN" = "1234"' },
    ],
  },

  // 24. field-fill REFUSES a native select (commit-by-selection, not free text) —
  //     symmetric with case 22, points at field-select + exits 1.
  {
    name: 'field-fill-on-select-refuses',
    fixture: 'native-select.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'State' },
      { verb: 'field-fill', args: ['e5', 'Texas'], expectExitCode: 1,
        expectStdoutMatches: [/"State" is select/, /field-select e5 --pick/] },
    ],
  },

  // 25. STALE-REF setter error: after a DOM-replacing navigation the setters
  //     surface resolveByRef's 'page changed … re-run: fields' text + exit 1
  //     (never mis-target a dead ref). Covers BOTH setters.
  {
    name: 'field-select-stale-ref',
    fixture: 'navigating.html',
    steps: [
      { verb: 'goto', args: ['$FIXTURE_URL'], expectStdoutMatches: /navigated to/ },
      { verb: 'fields', args: [], expectStdoutMatches: 'Applicant name' },
      { verb: 'click', args: ['#continue'], expectStdoutMatches: /clicked/ },
      { verb: 'field-select', args: ['e4', '--pick', 'foo'], expectExitCode: 1,
        expectStdoutMatches: [/page changed/, /re-run: fields/] },
    ],
  },

  // ── DISCOVERABILITY (phase 4) — `help` / `help <verb>` / unknown-verb guard ──
  // These run PRE-CONNECT (the manual for a confused agent), so they pass even
  // with CDP down / no fixture navigated. No goto step — the fixture field is a
  // placeholder the steps never reference.

  // 26. `help` prints the compact verb table from the ONE VERBS source of truth:
  //     grouped tiers, the field layer, and the recovery rule. Exit 0, no CDP.
  {
    name: 'help-lists-verbs',
    fixture: 'native-select.html',
    steps: [
      { verb: 'help', args: [],
        expectStdoutMatches: ['breeze browser driver', 'Field layer', 'fields', 'field-select',
          'field-fill', 'net-replay', /When confused, go UP a perception level/],
        expectExitCode: 0 },
    ],
  },

  // 27. `help <verb>` prints that one verb's usage + a runnable example.
  {
    name: 'help-one-verb-field-select',
    fixture: 'native-select.html',
    steps: [
      { verb: 'help', args: ['field-select'],
        expectStdoutMatches: ['field-select', 'usage:', '--pick <label>', 'example:'],
        expectExitCode: 0 },
    ],
  },

  // 28. UNKNOWN VERB: a typo gets a nearest-match suggestion + `try: help` on
  //     stderr and exits 1 — never a bare "unknown verb", never a CDP connect.
  {
    name: 'unknown-verb-suggests-nearest',
    fixture: 'native-select.html',
    steps: [
      { verb: 'feild-fil', args: [], expectExitCode: 1,
        expectStderrMatches: [/unknown verb: feild-fil/, /did you mean `field-fill`/, /try: help/] },
    ],
  },

  // NOTE — UNTESTED-LIVE (PHI path). `field-fill <ref> --data-ref <key>` and
  // `field-select <ref> --query-ref <key>` resolve their value in-process via the
  // SAME resolveDataRef plumbing as fill-ref/type-ref and require a running
  // TypeBuild task ($BREEZE_TYPEBUILD_TASK_ID) to resolve against, so they are NOT
  // driven here (the fixtures are file:// with no TypeBuild backend). Their
  // parity with fill-ref/type-ref is verified by code review, not this runner.
];

// (The former PENDING_CASES skeleton for the phase-3 setters is now ACTIVE —
// see cases 15–25 in CASES above. The one deviation from the skeleton: the huge
// native select is exercised by a SUBSTRING --pick ("Provider 00042") rather than
// --query, per the phase-3 spec; and Provider 00042's real label is
// "…— Specialty C" (i % 5 == 2), not "B" as the fixture comment guessed.)

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
  // stderr matchers — for verbs that write to stderr (the unknown-verb guard's
  // suggestion goes to stderr via fail(), matching every other CLI usage error).
  for (const m of asArray(step.expectStderrMatches)) {
    if (!matches(stderr, m)) failures.push(`stderr did not match ${m}`);
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
