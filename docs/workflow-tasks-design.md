# Workflow Tasks — Design

Status: draft · Owner: Vivek · Last updated: 2026-06-10

## Goal

Evolve the Breeze task system from a flat "what am I working on" list into a
single system that can also express **assignment, dependencies, and
agent-driven workflows** — without becoming Jira. The long-term intent is to
**consolidate onto one system and retire beads**, so Breeze tasks must be able
to carry the tactical structure (status, deps, ownership) that currently lives
in beads.

Guiding principle: **the simplest possible system that is at the same time
extremely powerful.** We get power not by adding control-flow machinery to the
data model, but by keeping the data thin and letting an intelligent agent
supply the control flow at runtime. Nothing the agent can infer is stored; only
what it *cannot* infer (hard constraints) and what it *must remember* (what
happened).

## What we are NOT building

No sprints, boards, story points, burndown, configurable workflow engines,
transition rules, required-field schemes, custom fields, permission schemes, or
a rich link taxonomy. No control-flow DSL. No `order` index on steps (redundant
with `blocked-by` — see below). These are team/process machinery with no payoff
for a solo + agents operator.

## Task fields (the data model)

Adds a small set of fields to the existing task (`id`, `title`, `notes`,
`folder`):

| Field          | Values                                   | Notes |
|----------------|------------------------------------------|-------|
| `status`       | `todo · in_progress · blocked · done`    | `blocked` is *derived* from open `blocked-by` edges |
| `assignee`     | `me · agent:<name> · unassigned`         | "assignee" is a person *or* a named agent |
| `priority`     | small enum (e.g. `P0–P3`)                | makes a long list scannable |
| `parent`       | task id (optional)                       | **containment** — "is part of". One level of nesting. |
| `blocked-by`   | set of task ids                          | **ordering** — "must come after". Directed, acyclic. |
| `kind`         | `task · template`                        | templates are recipes; excluded from ready/active views |
| `from_template`| task id (optional)                       | provenance: which definition a run was cloned from |

### Two edge types, kept orthogonal

- **`parent` (containment)** — what belongs to a workflow. A hierarchy axis.
- **`blocked-by` (ordering)** — what must run after what. A DAG axis.

Do not overload one to do the other. Containment groups the steps; blocked-by
sequences them. Two axes = fan-out, parallel branches, and joins for free.

### Why no `order` field

`blocked-by` already expresses ordering — and it expresses the *right* kind: a
**partial** order, not a forced **total** one. An edge means "this constraint is
real." The *absence* of an edge is permission for the agent to choose. So:

- no edges among children → "do all of these, you decide the order"
- a few edges → "these must be sequenced; everything else is your call"

An `order` index would encode ordering a second time and impose sequence where
none is required. Cut it.

## Workflows = task subgraphs

A workflow is not a new entity. It is a **named task subgraph**: a parent task
(the container) whose children are the steps, connected by `blocked-by` edges
only where order genuinely matters.

The critical split is **definition vs. run** — conflating them means every run
mutates and destroys the recipe.

### Workflow Definition (a template — never executed, only cloned)

- `kind: template`
- parent task `notes` = the **policy / intent** — the workflow's "system
  prompt": *"When you run this, think about the following… do A, then B, then
  C; skip D if no code changed; if tests fail, stop and notify me."*
- children (via `parent`), one per step, each with its own `notes`
- `blocked-by` edges **only** for mandatory sequencing

### Workflow Run (created by instantiating a definition)

- deep-copy the template + its children
- `kind: task`, all statuses reset to `todo`
- `from_template` link back to the definition
- anchored to a folder / moment; run-specific context dropped into the run's
  parent note

State is written on the **run's** children, never on the template. The template
stays pristine and reusable.

## The architecture: data plane vs. control plane

- **Task graph = data plane.** Holds *structure + state* only. It is the program
  *and* the program counter — nothing more.
- **Agent = interpreter / control plane.** Reads `ready` nodes, does the work,
  records state, and may grow the graph at runtime.
- **Cron = the clock.** Only triggers instantiation; holds no logic.

Mnemonic: **cron is the clock, the template is the program, the run-subgraph is
the program counter, the agent is the CPU, and the notes are the source code.**

### Execution loop (no engine required)

1. Load the parent note → that's the policy.
2. Pull all children; respect `blocked-by`, otherwise choose freely.
3. For each step, decide *run / skip / defer / parallelize* per the policy and
   what is observed.
4. Do the work, then **write `status` + a one-line outcome ("why")** on the
   child.
5. Optionally add new children if the work demands it (graph grows at runtime).
6. When all children are resolved, mark the run `done`.

### Per-child state is the one non-negotiable

Recording status + a one-line "why" on each child is **not** control flow — it's
memory. It buys two things:

- **Resumability** — cron re-fires or the agent crashes; the next agent reads
  state and continues instead of redoing. The whole cron+agent model depends on
  this.
- **Auditability** — a non-deterministic executor becomes trustworthy because
  every decision ("skipped deploy — no code changed") is written down and can be
  corrected by editing the *note*.

## Control flow lives in prose, not in fields

The agent supplies all conditionals, retries, skips, loops, and dynamic steps by
reading the note and writing state. Natural language has no expressiveness
ceiling, so the note can carry arbitrarily sophisticated policy. We consciously
accept the tradeoff: **no hard determinism.** For personal automation that's the
right call, and the recorded per-child ledger is the safety net.

## Where instructions live — a gradient by reuse × complexity

Pick the lowest rung that gives the reuse you need:

1. **Inline in a step's notes** — one-off / ad-hoc workflows. Dies with the run.
2. **A template task (`kind: template`)** — recurring workflows. Cron references
   the template by id. Editing the template *is* versioning it.
3. **An external recipe / skill file the task points to** — complex, shared, or
   code-like workflows. The note says *"run the recipe at `<path>`"*; the agent
   reads it. Conditionals, retry policy, long prose belong here — in a file an
   agent interprets, **not** in the data model.

Rule: structure + state go in the graph; the "how" goes in prose, at the lowest
rung that works.

## New primitives to build

Status already exists. On top of the field additions above:

- `kind: task | template` (+ exclude templates from ready/active views)
- an **instantiate** operation: clone a template subgraph → reset state → anchor
  → set `from_template`
- a `trigger` association (cron schedule → template id) so the clock knows what
  to instantiate
- agents permitted to **create tasks at runtime** inside a run's subgraph
- a **`breeze ready`** query: tasks with no open `blocked-by` blockers — the
  highest-value thing dependencies unlock (mirrors `bd ready`)

## Minimal model, restated

**parent note (policy) + children (steps) + blocked-by (only the real
constraints) + template/run split + per-child status (the ledger).**

Five ideas, all already tasks. Zero control-flow machinery.

## Open questions / next steps

- [ ] Confirm the exact Breeze task schema today and where these fields slot in.
- [ ] How is `blocked` status derived & kept in sync as blockers close?
- [ ] Cron ↔ template trigger wiring (where the association is stored).
- [ ] `instantiate` semantics: deep-copy depth, how run context is injected.
- [ ] Migration: map current beads-tracked work onto this single model.
- [ ] UI: how the graph (containment + ordering) is shown without clutter.
