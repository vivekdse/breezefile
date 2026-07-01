# API knowledge as reusable tools — design note

**Status:** Design note 2026-07-01, **revised to Vivek's model.** Supersedes the
earlier "control/data-plane routing seam" framing (which over-built the problem).
Task: `task-f83843b6c053`, child of the Operator Speed epic `task-23b99b1d2675`.

## The reframe (Vivek, 2026-07-01)

The Operator Speed "tier ladder" implied API execution was a **separate engine** the
system routes to. It isn't. The real picture:

- **There is ONE executor: an agent in a terminal.** Every task is agent-driven, and
  the agent already runs in a terminal.
- From that terminal the agent can do anything — drive a **browser** (a tool) or just
  run **`curl`** (also just the terminal). "API execution" is not new machinery; it is
  the agent **choosing `curl` instead of opening a browser**. No router, no second
  runner, no control/data-plane split to build for this.
- So **how a task executes rests with the task/agent**, uniformly. There is no
  per-tool "execution engine" flag that switches runtimes.

That collapses the problem to **one thing worth building:**

> **The agent should not have to re-learn a site's API every time.** Discovering that
> "the payer portal's submit is really `POST /api/claims` with these headers / this
> body" is expensive. The waste is rediscovering it on the next task against the same
> site. Persist that knowledge so the next run just `curl`s it.

## The answer: reuse the tool + memory infra we already shipped

API knowledge fits the webpage-automation infrastructure with **no new subsystems** —
only extensions. An "API tool" is just a **tool whose steps are HTTP/`curl`** instead
of Playwright clicks.

### 1. Tools already are the right artifact
`bin/breeze-tools.mjs` + `electron/browser/tools/registry.mjs`: a tool is a reusable,
versioned, **step-structured** artifact with a typed `{status,code,result}` contract,
`me.*` credential refs resolved locally (never a literal secret in the code — see
`electron/browser/tools/promote.mjs:23`), resume/repair, and `runs.jsonl` health.
**None of that is browser-specific except the body of each step.** A step whose body
is a `fetch`/`curl` is the *same artifact*: same registry, same resume, same
human-gated-submit rule for the irreversible call, same promotion loop.

- Add a NON-PHI `channel` marker on the tool (`browser` default | `http`) so the agent
  and discovery know the steps are HTTP and the browser can be skipped. This is a
  *label on the artifact*, **not** a runtime router — the agent reads it, nothing
  "routes" on it.

### 2. Site-memory already holds per-site knowledge
`electron/browser/tools/memory.mjs` + `electron/typebuild/site-memory.ts`: NON-PHI,
keyed by **domain + task_tag**, synced across machines. This is exactly where the API
spec belongs — "for `payer.example.com`, submit = `POST /api/claims`, auth
`me.payer_token`, body shape `{...}` (KEYS only, no values)." The agent recalls it at
the start of a task and skips rediscovery. Same key, same NON-PHI discipline, same
cross-machine sync as webpage memory.

### 3. Discovery + promotion already exist — extend, don't build
- **Network-interception lever** (`task-eea958a7d396`, shipped): the agent can already
  watch the page's own XHR/fetch and see the real underlying request. **This is the
  discovery mechanism.**
- **Auto-promotion** (`task-20b82e75a1cc`, shipped): a successful novel solve already
  auto-emits a reusable tool. **Extend it** so that when the solve *was* an intercepted
  API call, the emitted tool's steps are `curl`/HTTP (`channel: http`) rather than
  clicks, and the API spec is written to the domain-keyed site-memory note.
- **Param-binding memory** (`task-a7e56f6bc583`, shipped): already remembers
  keys-only "which task-data-key feeds which param" — reused unchanged for HTTP params.

### The loop, end to end
Agent hits a novel site → drives the browser to solve it → the interception lever
captures the underlying API request → auto-promotion emits an `http`-channel tool +
writes the API spec to site-memory (NON-PHI, KEYS only) → **next task on that domain:
the agent recalls the memory + tool and just `curl`s it — no browser, no rediscovery.**

## Invariants preserved (unchanged from the tool system)
- **Creds resolve locally via the vault** (`me.*` → `/chromeext/entities/resolve`,
  `electron/typebuild/user-vault.ts:42`); an API token is just another `me.<svc>_token`
  ref. Never a literal value in tool code, memory, logs, or the server.
- **Irreversible calls stay human-gated** — an HTTP `POST` that submits is a
  side-effecting step, same rule as a browser submit.
- **Memory is NON-PHI, KEYS-only** — API endpoint shapes and placeholder keys, never
  request/response values.

## What is explicitly NOT being built (retired from the earlier note)
- ~~A separate "API runner" / typed-FastAPI execution path~~ — the agent+terminal IS
  the executor; it runs `curl`.
- ~~Control-plane/data-plane routing seam at "Play"~~ — no routing decision exists; the
  agent picks the tool.
- ~~A distinct client-side capability/integration registry~~ — "which APIs do I have
  auth for" is answered by which `me.*` tokens exist + which `http` tools/memory notes
  exist for the domain. No separate registry.
- The **offline/cron always-on runner** is a real want but is a *separate concern* from
  API knowledge, already tracked as `task-aa176d666084` ([FUTURE] always-on Runner). It
  is not part of this task.

## Build scope (small — one task)
Extend the existing promotion + memory paths to cover HTTP:
1. `channel: 'browser' | 'http'` NON-PHI marker on the tool schema
   (`registry.mjs`), defaulting to `browser` (existing tools unchanged).
2. Auto-promotion: when a solve carries an intercepted API request, emit an
   `http`-channel tool whose steps are `curl`/`fetch` with `me.*` refs (extend
   `electron/browser/tools/promote.mjs` + the network lever's output).
3. Site-memory: persist the discovered API spec as a domain-keyed NON-PHI note
   (endpoint, method, header/param KEYS, `me.*` auth ref) via the existing
   `memory.mjs` / `site-memory.ts` path; agent recalls it before falling back to the
   browser.
4. Tests: an `http`-channel tool round-trips through the runner; a promoted API tool
   is NON-PHI (no values); memory recall returns the spec keyed by domain.

No new store, no runner, no routing layer. Filed as the single build task under this
one.
