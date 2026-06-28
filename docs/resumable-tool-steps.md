# Resumable tool steps (Operator Speed)

A browser-automation **tool** used to be one opaque `async run(ctx, params)`. Its
"steps" were just `log.step()` lines, so a partial break could not be resumed and
a re-run re-fired side effects (e.g. a double form-submit — which violates the
human-gated-submit rule). This change turns a tool into **ordered, named steps**,
each marked idempotent vs side-effecting, with a runner that can **resume** from a
given step without re-firing a completed side effect.

Code: `electron/browser/tools/registry.mjs` (pure planning core) and
`bin/breeze-tools.mjs` (`run` command). Worked example:
`electron/browser/tools/seed/gmail-prefill-send/`.

## The `steps[]` schema

A `tool.mjs` may export an ordered `steps` array **instead of (or alongside)** a
single `run`:

```js
export const steps = [
  { name: 'compose', sideEffect: false, run: composeFn },
  { name: 'send',    sideEffect: true,  pre: gateFn, post: verifyFn, run: sendFn },
];
```

Each step is:

| field        | required | meaning |
|--------------|----------|---------|
| `name`       | yes      | unique, `^[a-z0-9][a-z0-9_-]*$`. The resume handle + the only thing written to `runs.jsonl`. |
| `sideEffect` | no (default `false`) | `true` = irreversible (submit/send/pay). Governs the safety gate. |
| `run`        | yes      | `async (ctx, params, state) => result` — the step body. |
| `pre`        | no       | `async (ctx, params, state) => boolean` — guard run **before** the body. Returning `false` aborts the step *before* it fires (the human-gate point for a side effect). |
| `post`       | no       | `async (ctx, params, state, result) => boolean` — verify the step achieved its goal; `false` fails it. |

`ctx` gains a `state` scratchpad shared across steps (NON-PHI by convention —
never a form value). `tool.json` may also **declare** `steps: [{ name, sideEffect,
description }]` so `help`/discovery can show the plan without importing the module;
the module's exported `steps` is authoritative at run time.

### Back-compatibility

A tool that exports **only `run`** (no `steps`) is normalized to **one implicit
step** named `run`, marked `sideEffect: true` and non-resumable. `sideEffect:true`
is the *safe* default: an opaque legacy run might submit a form, so the runner must
never auto-replay it. Existing single-`run` tools and existing playbook calls work
unchanged.

## Cursor / resume mechanism

The cursor lives in the **existing `runs.jsonl`** (no parallel store). Each run
record gains two NON-PHI fields:

```jsonc
{ "timestamp": "...", "status": "partial", "code": 6,
  "steps_done": ["compose"], "failed_step": "send", "params": { ... } }
```

- On a partial break (some steps done, more remain) the runner emits **exit code 6
  (PARTIAL)** — the pre-existing "partial" signal — and the JSON output carries
  `failed_step` + `resume_from` (the step to restart at).
- `run <tool> --resume-from <step>` restarts **at** that named step. Steps before
  it are skipped (treated as already done).
- With no `--resume-from`, if the **last** run record was `partial`, the runner
  **auto-resumes** from the first step not in `steps_done`. A clean success or a
  hard failure starts fresh.
- `run <tool> --dry-run` prints the computed plan (`skip`, `plan`, `start_index`,
  per-step `sideEffect`) **without a browser** — the offline check used by tests
  and by an agent deciding how to resume.

`lastCursor()` reads the most recent record carrying step data; `planResume()`
computes `{ startIndex, skip, plan }` purely.

## The side-effect-safety invariant (load-bearing)

> **Resume must START AT OR AFTER the broken step, and a completed side-effect
> step must never re-fire.**

This is enforced in `planResume()` by two checks over the steps, given the resume
cursor (`startIndex`) and the set of `steps_done` from `runs.jsonl`:

1. **No replay.** For every step **at or after** the cursor: if it is a
   `sideEffect` step that is **already in `steps_done`**, the resume is *refused*
   (exit 7, precondition) — running it would re-fire it. Because a step is written
   to `steps_done` **only after its body (and `post`) succeed**, a completed side
   effect is durably recorded; a resume can therefore only legally start *strictly
   after* it.

2. **No phantom skip.** For every step **before** the cursor (which will be
   skipped): if it is a `sideEffect` step **not** in `steps_done`, the resume is
   refused — skipping it would falsely assume an effect that never happened.

Why this is provably safe for the load-bearing case (double-submit):

- A side-effect step is recorded done **only on success**. So after a partial
  break, the broken side-effect step is *either* recorded done (it fired) *or*
  not (it didn't).
- If it fired: it is in `steps_done`. Any resume that would run it again (cursor
  at-or-before it) is refused by check (1). The only legal resume starts *after*
  it — so it cannot fire twice.
- If it did not fire: it is the failed step; resume restarts **at** it (a first
  attempt, not a replay). Skipping it is impossible without tripping check (2).

The default `--resume-from <broken-step>` always lands the cursor **at** the
broken step, never before it — so completed earlier side effects are in the `skip`
set *and* recorded done (passing check 2), and the broken step is run for the first
time. There is no resume path that re-runs a recorded side effect.

Additionally, the legacy implicit `run` step is `sideEffect:true`, so the runner
never auto-resumes it.

## Repair tier (wired)

The playbook (`playbookBody()` in `electron/browser/automation.ts`) now makes the
**repair tier** the DEFAULT next move on any non-zero tool exit, before falling
back to the slow full-agent path. The branch keys off the standardized
`error.likely_cause` field on every failing result (`{ param | selector_drift |
precondition | auth | timeout | unknown }`, mapped from `category` by the
`LIKELY_CAUSE` table in `registry.mjs`):

- `param` / `precondition` / `auth` → re-run with corrected params / resolve the
  precondition or creds — **don't touch tool code**.
- `selector_drift` (exit 5) → patch `tool.mjs`, `update` the tool, re-run.
- `timeout` → retry with backoff.
- `unknown` → escalate to the full-agent path.

On a **partial (exit 6)**, the agent reads `failed_step` + `resume_from`, fixes
step k (selector/params/code), and re-runs with `--resume-from <failed_step>` so
steps 1..k-1 — including any completed side-effect/submit — do not re-fire (the
no-double-submit invariant above). Full-agent is reached only after N failed
repairs; after a full-agent solve the playbook references a **promotion hook**
(emit a tool) so the flow graduates back to tier 2.

## Step plan + cursor health in `help`/`available`

`help <tool>` and `available <url>` surface a NON-PHI **step-plan + cursor**
summary (`registry.mjs` `stepPlanSummary()`), so a human or LLM sees a tool's
ordered steps, which are side-effecting, and where it's resumable from WITHOUT
importing the module or parsing `runs.jsonl` by hand:

```jsonc
"_step_plan": {                       // help; "step_plan" on available entries
  "steps": [ { "index": 0, "name": "locate-fields", "sideEffect": false, "description": "…" },
             { "index": 1, "name": "submit", "sideEffect": true,  "description": "…" } ],
  "side_effecting": ["submit"],       // the irreversible / gated steps
  "cursor": { "status": "partial", "steps_done": ["locate-fields"],
              "failed_step": "submit", "resume_from": "submit", "resumable": true }
}
```

It reads ONLY the DECLARED `tool.json` `steps` (advisory mirror of the module's
authoritative export) plus the last `runs.jsonl` cursor — names, statuses and
indices only, never params/values. A legacy single-`run` tool declares no steps,
so `steps` is `null` and `cursor.resumable` is `false`.

## The API shortcut (network observe / replay)

Playwright's biggest speed edge: read/replay the page's OWN XHR/fetch and skip
the rendered UI. Two raw-driver verbs (`electron/browser/net.mjs`, surfaced in
`electron/browser/cli.mjs`):

- `net-observe [urlFilter] [--ms n]` — watch the page's xhr/fetch for a window and
  report the API requests seen as **NON-PHI metadata** (method, url, status,
  content-type, header *names* — never values, never bodies). The discovery step:
  run it, nudge the page, learn which request carries the data.
- `net-replay <url> [--method M] [--data s]` — re-issue that request through the
  page's own signed-in context (`page.request.fetch`), no DOM, no re-auth. A
  GET/HEAD is a safe read; a **mutating** method (POST/PUT/PATCH/DELETE) is a side
  effect and is **refused** unless `--allow-mutation` (the human-gated-submit
  rule). The runner exposes the same helpers to a tool as `ctx.replay`.

The playbook (`playbookBody()`) makes the API shortcut the on-ramp to tier 1: when
a flow can be satisfied by the page's underlying request, prefer it and **capture
it as the tool's fast path** (a `net-replay` step).

## Auto-promotion (full-agent solve → candidate tool)

A full-agent (tier-4) solve **auto-emits a reusable tool** so a novel page is paid
for ONCE. `electron/browser/tools/promote.mjs` `scaffoldTool()` turns a captured
raw-driver verb sequence (and/or a `record.ts` recorded flow) into a
**step-structured** `tool.mjs` + `tool.json`, written via
`breeze-tools promote-from <id> --match <url> --actions <f.json>` (or
`--recording`). The emitted tool:

- is **step-structured** (one step per captured action; a mutating `net-replay`
  becomes a `sideEffect:true` step the runner gates + never re-fires on resume),
- is **NON-PHI**: a captured fill carries a placeholder KEY (`patient.ssn`) or a
  `{{param}}` ref, **never a value** — `scaffoldTool()` *refuses* a literal value;
  the tool syncs as a code artifact through the same channel the tool repo uses,
- starts `status: candidate` and **auto-promotes to `active`** after it proves
  itself: `promotionDecision()` flips it once it has `PROMOTE_MIN_SUCCESSES` (2)
  clean runs at a 100% rate (a failure keeps it candidate so the agent repairs it
  first). The runner calls `maybePromote()` after each successful run.

The playbook's promotion hook is now concrete: it names `promote-from` as the move
after a full-agent solve.

## Deferred follow-ups

- **API channel (tier 1):** the playbook states the tier order (API → tool →
  repair → full agent) and the API *shortcut* (observe/replay above) is the
  on-ramp, but a direct first-class API/integration channel — a typed call with
  token auth, cron-able, no browser, no LLM — is still a separate architectural
  task (`task-f83843b6c053`), held for the human.
