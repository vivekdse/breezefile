# Customer Problem Statement — Breezefile Task Experience

## Who the user is

**Vivek (the operator)** — a power user who lives in the keyboard. He started Breezefile as a
file manager and grew it into the place where he *runs agents*. He defines work as tasks, hands
them to Claude Code agents (locally on a cron, or via the shared encrypted TypeBuild queue), and
expects them to execute while he does other things. He also collaborates with a **small team** who
share the TypeBuild queue — they claim, assign, and pick up each other's work.

He is not a project manager. He does not want Jira. His mental model is *"the simplest possible
system that is at the same time extremely powerful"*: thin task data, with an intelligent agent
supplying the control flow at runtime.

## What he wants

> "I want to point at intent, hand it to an agent, walk away, and trust that I'll know exactly what
> happened when I come back — without drowning in a cluttered control panel."

Three jobs, in priority order:

1. **Monitor running agents live.** Today an agent run is "a terminal tab." He can't glance and
   know which of his agents are working, which are stuck, which need him, or what they've changed —
   without clicking into each terminal. He wants situational awareness across *all* running agents
   at once, and a way to drop in, steer, or stop one mid-flight.

2. **Triage the task overview.** The Tasks page partitions into FOR YOU / FOR AGENTS / DONE, with
   rows carrying status dots, priority steppers, pins, due chips, child-progress pills, blocked
   pills, claimed-by labels, raw-status badges, kebab menus, and a heavy right-hand detail pane.
   It is **cluttered**. Every control is individually justified but collectively overwhelming. He
   wants to open the page and instantly know *what needs me, what's moving, what's done* — and have
   everything else recede until asked for.

3. **Create agentic tasks from intent.** Today creation is a multi-step form (title, folder, who,
   notes, dates, status, pin, priority, flags: interactive/chrome/auto-accept, cron). For a human
   to-do that's fine; for *defining what an agent should do* it's friction. He wants to express
   intent in plain language and have the system shape it into a runnable, schedulable agent task —
   leading with recipes/templates, not a blank multi-field form.

## Current journey & where it breaks

| Step | Today | Pain |
|------|-------|------|
| **See what's happening** | Open Tasks tab → scan three sections → click into terminal tabs one by one | No live, at-a-glance view of running agents. Monitoring = tab-hopping. |
| **Decide what to do** | Parse a dense row with 8+ affordances + a detail pane | Cognitive load. Signal (needs me / blocked / done) buried under controls. |
| **Spin up agent work** | `:task` → multi-step form → pick source → set flags/cron | Form-shaped, not intent-shaped. Heavy for "go do this thing." |
| **Steer a run** | Find its terminal tab, type into it | No first-class "intervene" affordance; no batch control over many runs. |
| **Review results** | Reopen session / Run history dialog / Runs view | Output is a terminal scrollback, not a reviewable summary of *what changed*. |

## Core needs (testable)

- **N1 — Live agent awareness:** one surface that shows every running agent's state (working /
  waiting-on-me / blocked / done) and last action, updating in real time, without opening terminals.
- **N2 — Calm triage:** the overview leads with *what needs attention*; secondary controls are one
  action away, not always on screen. Critical functionality preserved, visual load cut.
- **N3 — Intent-first creation:** describe the work in a sentence; the system proposes the task
  (agent, schedule, folder, steps) and asks only what it can't infer. Templates/recipes lead.
- **N4 — In-flight control:** drop into a run, give it a nudge, pause/stop/retry — individually or
  in batch — as a first-class action, not "go find the terminal."
- **N5 — Trustworthy handoff & team coordination:** claim/assign/lifecycle for the shared queue
  stays legible; you can see who owns what and what an agent decided ("skipped deploy — no code
  changed") without spelunking.
- **N6 — Reviewable results:** when an agent finishes, you get a structured summary of what it did
  and changed, with accept/redo/dig-in — not just raw scrollback.

## Constraints / invariants

- **PHI safety:** TypeBuild task titles/bodies are encrypted; decrypted text is memory-only, never
  on disk/logs/notifications. Any design touching TypeBuild content must respect this.
- **Thin data, agent control plane:** don't design UI that demands a heavy control-flow data model.
  Structure + state in the graph; the "how" lives in prose the agent interprets.
- **Cross-platform (Mac + Linux):** OS-coupled affordances go through the platform adapter.
- **Keyboard-first:** typing the action beats memorizing chords; bold reimaginings must keep a fast
  keyboard path.
