# TypeBuild — Value Proposition

> Living document. Start small; add propositions as we learn what
> actually matters to users. Every claim here should show up somewhere
> in the product (copy, onboarding, help) or be cut.
>
> **Reframed 2026-06-24.** This product began as *Breeze File*, a
> keyboard-first file manager. It is now the **TypeBuild client**: the place
> a person and their team get work done with AI agents. The file-manager
> value props are preserved at the bottom as the "abilities" layer, since
> they're still true and still ship — but they are no longer the core promise.

## The core promise

**TypeBuild is the client where you and your team get things done with AI
agents — you see every task, run it (yourself or hand it to an agent), and watch
the automated work happen.**

That is the whole product in one sentence. Everything else is in
service of it.

## What that means in practice

### Tasks are the primitive

Work is expressed as **tasks**, not files or chats. A task is a unit of work for
a human or an agent. The client's job is to make the full set of your tasks
visible, executable, and observable in one place — what's ready, what's running,
what an agent is doing right now, and what's blocked.

### Online and shared — across people and machines

Tasks live online, in the TypeBuild service. That means they are **shared**: a
task can be distributed across a team, or across one person's several machines.
You pick up where any of your machines left off, and you can see what your
teammates' agents are working through. There is no separate local task list to
keep in sync — there is one system.

### Agents do the work; you stay in control

The client gives agents the abilities they need to complete a task — operating
your browser (Playwright-driven), touching files, opening apps — while keeping
you in the loop. Confirmation is task-dependent, not a blanket rule: a task's
flags decide whether it runs interactively (browser tasks, where a human is
present to confirm sensitive steps like a form submission) or unattended
(headless-safe tasks). PII stays out of the agent's context by design
(placeholder keys, server-side decryption — see the data-field contract). You
watch the work, not just the result.

### Auditable, resumable automation

Because tasks carry state and a one-line "why" on every step, automated work is
**resumable** (an agent crashes or a schedule re-fires; the next agent reads
state and continues) and **auditable** (every decision is written down and can be
corrected by editing the task). A non-deterministic executor becomes trustworthy.

## The abilities layer (formerly the whole product)

The keyboard-first file manager that this project started as is now an **ability
set** the client and its agents use. These propositions are still true and still
ship:

- **Easy, fast, keyboard-first file work.** Common file actions (find, move,
  rename, send somewhere) are reachable without hunting through menus or
  memorizing chords.
- **Type the action you want.** Want to copy? Type `copy`. Move? Type `move`.
  The app fills in the rest. Chords exist as shortcuts for actions you've
  already learned — not the primary surface.
- **Native drag-out to web apps** (Slack, Gmail, Finder) — the original reason
  the file manager existed, still the best-in-class affordance for getting a
  file *out* to where the work is.

These remain in the product; they are the means, not the end.

## Guardrails for future propositions

As we add value propositions, they should:

- Be **testable** against real user behavior — not aspirational.
- Point to a **concrete surface** in the product (a task view, a verb, a flow,
  an agent ability).
- Be **true today**, not "true once we ship feature X."
- Stay short. If a value prop needs three paragraphs to explain, it
  isn't one yet.
