# Value Cards — Breezefile Task Experience

Every variation is judged against these values. Each card names the stakeholder, the value, why it
matters here, and what "honoring it" looks like in the design.

---

## Direct stakeholders

### V1 — Calm Clarity *(the operator)*
**Value:** The interface should reduce cognitive load, not add to it. Open the page → instantly know
what needs me, what's moving, what's done.
**Why:** Today's page is cluttered; every control is justified but collectively overwhelming.
**Honoring it:** Strong visual hierarchy; signal over chrome; secondary controls one action away;
delightful, not dense. Calm by default, powerful on demand.

### V2 — Live Situational Awareness *(the operator)*
**Value:** Know what every running agent is doing — right now — without opening terminals.
**Why:** Monitoring today is tab-hopping; you can't glance and triage across many agents.
**Honoring it:** A real-time view of agent state (working / waiting-on-me / blocked / done), last
action, and progress. Attention is pulled to runs that need a human.

### V3 — Direct Control *(the operator)*
**Value:** Steer, pause, stop, retry a run — and act on many at once — as a first-class affordance.
**Why:** Intervening today means finding the terminal and typing into it; no batch control.
**Honoring it:** Drop-in / nudge / stop visible on each run; bulk actions over selected runs;
cancel/stop always reachable; irreversible/credit-consuming actions preview before they fire.

### V4 — Intent → Action *(the operator)*
**Value:** Express work in a sentence; the system shapes it into a runnable agent task.
**Why:** Creation is a multi-step form — heavy for "go do this thing."
**Honoring it:** Plain-language entry; system proposes agent/schedule/folder/steps; asks only what
it can't infer; leads with templates/recipes and recently-used, not a blank form.

### V5 — Trust & Auditability *(the operator + team)*
**Value:** Trust a non-deterministic executor because every decision is written down and correctable.
**Why:** Agents skip/defer/retry by reading prose and writing state; that ledger is the safety net.
**Honoring it:** Each step shows status + a one-line "why"; finished runs give a structured summary
of what changed with accept/redo; errors say what happened, why, and what to do next.

---

## Indirect stakeholders

### V6 — Team Coordination *(the small team on the shared queue)*
**Value:** See who owns what; claim/assign/hand off without stepping on each other.
**Why:** TypeBuild is a shared encrypted queue — claim, assign, lifecycle, attempts.
**Honoring it:** Ownership legible at a glance; claim/assign/release stays simple; you can tell a
human task from an agent task and a mine from a theirs without reading badges.

### V7 — Confidentiality *(the team / data subjects)*
**Value:** Encrypted task content stays protected.
**Why:** TypeBuild titles/bodies are PHI; decrypted text is memory-only.
**Honoring it:** No design surfaces decrypted content where it would persist (logs, notifications,
disk). Live views can show *state* freely but gate *content* behind the in-memory, on-focus reveal.

### V8 — Power Without Machinery *(the operator, as system designer)*
**Value:** Stay the simplest possible system that is at the same time extremely powerful.
**Why:** No sprints/boards/DSLs; power comes from a thin graph + an intelligent agent at runtime.
**Honoring it:** Don't invent heavy control-flow UI. Express containment + ordering + per-step state
minimally; let prose and the agent carry the "how." Keep a fast keyboard path through everything.
