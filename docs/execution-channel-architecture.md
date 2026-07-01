# Execution-channel architecture — Tier-1 API channel (design note)

**Status:** Design note 2026-07-01; **awaiting Vivek's review before any build.**
Task: `task-f83843b6c053` ("Tier-1 API execution channel: execution-mode on task +
runner routing (control/data-plane split)"), a child of the Operator Speed epic
`task-23b99b1d2675`. **This is a design note only** — no schema, routes, or runner
changes until the open questions below are answered.

## Why this exists

The Operator Speed thesis is a fastest-first tier ladder: **API channel → deterministic
tool → repair → full browser agent.** Tiers 2–4 are built (resumable tools, `likely_cause`
repair, auto-promotion). **Tier 1 — the API channel — is not.** It is the fastest tier:
a task backed by a registered API integration runs as a typed FastAPI/terminal call with
token auth — **milliseconds, cron-able, no browser, no LLM.** The fastest click is the
one you never make; the fastest tool run is the one that never opens a browser.

The seam everything hangs off is an **execution-mode on the task/tool** (`browser | api`),
and a **routing decision at "Play"** that picks the channel. This note recommends how to
build that seam without violating the load-bearing HIPAA / no-server-execution rules.

## Grounding in current code (paths real as of this writing)

- **TaskSource seam:** `electron/core/task-source.ts:95` (`interface TaskSource`,
  `listTasks`/`getTask`, `capabilities` at `:101`). The registry aggregates sources
  (`electron/sources/registry.ts`).
- **Runner precedent:** the per-machine daemon + `claim_next_task` loop lives across
  `electron/remoteDaemon.ts`, `electron/scheduler.ts`, `electron/sources.ts`,
  `electron/core/host.ts`. This is the data-plane executor to reuse.
- **Tool = universal artifact, channel is a property of it:** the tool runner
  (`bin/breeze-tools.mjs`) + registry (`electron/browser/tools/registry.mjs`) already
  model a tool as ordered `steps[]` with a `{status,code,result}` contract. Today every
  tool is implicitly `channel: browser` (Playwright). Tier 1 makes `channel` explicit.
- **Creds/PHI via the vault, resolved locally:** `electron/typebuild/user-vault.ts:42`
  (`GET /chromeext/entities/resolve?entity=me&field=<name>`), `resolveDataRef` in
  `electron/browser/connect.mjs` (re-exported through `cli.mjs`), the `me.*` / data-key
  discipline in `electron/browser/tools/promote.mjs:23` (a fill carries a KEY, never a
  value). API tokens ride the SAME mechanism — `me.<service>_token` resolves locally.

## The two planes (load-bearing — this is the HIPAA line)

- **Control plane = the TypeBuild server, forever.** Schedule/cron, task queue, dispatch,
  `notify_user`, audit. Stores automation **code** as NON-PHI artifacts but **NEVER
  executes it** and **NEVER holds third-party creds.**
- **Data plane = the user's trust boundary (a runner).** Pulls the tool, resolves creds
  locally via the vault, runs it, reports back via `submit_task`. Reuses the existing
  `breezed` daemon + `claim_next_task`.
- **"Offline / cron" without putting execution on the server:** the user designates an
  always-on runner that is still *theirs* — their own always-on box, or their own cloud
  runner triggered by webhook/queue. The server fires the schedule; whichever of the
  user's runners is online claims it. (Optional LATER, opt-in/paid: a single-tenant hosted
  runner for users who refuse to run infra — framed as "a runner that's logically yours,"
  not execution in the shared brain.)
- **No code execution on the server, ever.** This is the clean security boundary and the
  HIPAA story.

## Recommended build shape (fastest win first)

The task calls out the **first child seam**: *"execution-mode on task + runner routing at
Play"* — build this before registry/auth polish; it is where the tiering decision lives.
Recommended phasing:

**Phase A — the routing seam (minimal, high-value).**
1. `execution_mode: 'browser' | 'api'` as a property that resolves from the selected
   **tool** (channel is a property of the tool artifact), with an optional override on the
   task. Default `browser` → today's behavior is byte-for-byte unchanged.
2. At **Play**, route by channel: `api` → the typed-call executor (no browser, no LLM);
   `browser` → the existing agent/tool path. Both run in the data-plane runner.
3. An `api`-channel tool is a typed request spec (method/url/body-template/param schema)
   whose secret refs are `me.*` KEYS resolved locally at run time — identical discipline
   to the browser tools' `fillRef`. Irreversible calls stay human-gated (same rule as a
   side-effecting browser step).

**Phase B — the capability/integration registry.**
4. A client-side registry keyed by service: *which APIs does this user have auth for*
   (i.e. which `me.<service>_token` entities exist). Play consults it to decide whether the
   `api` fast path is available or it must fall back to the browser channel.

**Phase C — cron/offline runner decoupling.**
5. Let a user designate an always-on runner (their box or their cloud runner) so scheduled
   `api`-channel tasks run without the laptop open. Builds on `claim_next_task`.
   *(This is close to the existing `[FUTURE]` always-on Runner task `task-aa176d666084` —
   they should be reconciled; see open question 5.)*

## Open questions for Vivek (answer to unblock the build)

1. **Where does `channel` live — on the tool, the task, or both?** Recommendation: primary
   on the **tool** (a tool IS browser-or-api), with an optional per-task override for the
   rare "force browser" case. Agree?
2. **Phase A scope for v1:** just the routing seam + a single hand-written `api`-channel
   example tool (proving the path end-to-end), deferring the registry (Phase B) and the
   cron runner (Phase C)? Or bundle B in v1?
3. **Promotion tie-in:** auto-promotion (`task-20b82e75a1cc`) currently emits *browser*
   tools. When the operator discovers a page's underlying API (the network-interception
   lever, `task-eea958a7d396`), should a successful API discovery **auto-emit an
   `api`-channel tool**? (This is the "in-page API becomes a standalone API tool" on-ramp
   the epic describes.) In v1 or later?
4. **Epic or child?** The task itself notes it "may warrant promoting to its own epic if it
   grows." With Phases A–C it is clearly epic-sized. Promote to an epic with A/B/C as
   children, or keep it a single task scoped to Phase A only?
5. **Reconcile with the `[FUTURE]` always-on Runner** (`task-aa176d666084`, in Small
   Business Software): Phase C here and that task are the same idea. Fold Phase C into that
   task, or keep it as a child of this epic and mark the other superseded?
6. **Terminal channel:** the task says "FastAPI/terminal call." Is a local **terminal/CLI**
   execution mode (run a shell tool with token auth) in scope alongside HTTP `api`, or is
   v1 HTTP-only?

After you answer, I'll create the build task(s) — starting with Phase A (the routing seam),
which is the smallest end-to-end proof and unblocks the rest.
