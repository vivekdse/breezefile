# Home redesign — inspirations (task-first work client)

<br />

These four new variations (13–16) continue the inspirations series. They explore the
**parent goal: move the home from file-manager → task-first work client.** The file
surface drops to *one ability among many*; tasks become the primary surface.

Every direction was built to do three things at once:

1. **Task-first home** — lead with what I have to do, what's running, what's automated,
   and what needs my attention. One bright *"what needs me now"* focal point; calm by default.
2. **Feature discovery** — surface **and teach** the client's abilities (task management,
   desktop notifications, Chrome/browser automation, file abilities, agents) instead of
   burying them. Each shows the abilities with their **verbs**.
3. **Online ↔ desktop split** — make legible what is **☁ online** (TypeBuild task state,
   available from any machine) vs **▣ this Mac** (notifications, browser automation, file
   abilities — desktop-only). The split is visible in each design, expressed differently.

All four stay **keyboard-first / verb-based**: the `:` command palette + sentence-chip verb
spine, a status bar with MODE + live summary, and vim motion (`j/k`, plus `h/l` where it
makes sense). They reuse the **Alpine-dusk design tokens** (token hex/spacing/type pulled
from `src/styles/tokens.css`) so they read as the same app — calm, ~3 attention colors
(teal = working, amber = needs-you, red = blocked), deferred detail behind disclosure.

They all run the **same scenario** as variations 10–12 (Nightly deploy blocked 41 min on
red `auth.spec.ts`, citing the project rule "Never merge with red CI"; Triage + Refactor
agents working; Migrate-CRM waiting on a y/n; the team = you / Priya / Sam) so you can
compare paradigms on identical data.

<br />

## The four directions

<br />

### 13 — Now Board  (`variation-13-now-board.html`)
**A what-needs-me-now triage home.** Opens on a single full-width **Now card** — the one
blocked deploy, full reason, the rule that held it, and act/override/stop/skip — then three
calm derived columns (**Needs you · Running · Automated**). An **Abilities dock** at the foot
teaches the five client powers as labeled launchers. Every item is stamped ☁ online or ▣ desktop.
- **Leans into:** task-first home + the single focal point. Calmest of the four; "1 of 3 need
  you, the rest can wait."

<br />

### 14 — Agent Pulse  (`variation-14-agent-pulse.html`)
**A live agent-activity feed.** A pinned needs-you ribbon over a time-ordered feed that
**reorders live** off real TypeBuild statuses (open · claimed · working · waiting · blocked ·
done), with a JS tick appending new events. Down the left edge runs a **two-rail spine** —
☁ online vs ▣ this Mac — and every event docks onto the rail that did the work, so you *see*
which half of the system acted (a file read, a Chrome question, a TypeBuild state change).
- **Leans into:** online↔desktop split + live situational awareness. The most "alive" of the four.

<br />

### 15 — Ability Launcher  (`variation-15-ability-launcher.html`)
**A feature-discovery launcher home.** A tight live work-strip leads (needs-you focal + working +
automated), then the body is a **launcher of the client's abilities** — each a generous teaching
tile: what it does, its verb + key, where it runs (☁/▣), a "learn →" link, and a live status if
active. A "4 of 5 tried" progress meter and a "try this" nudge make **discovery a first-class goal**;
a recipes row leads creation with templates, not a blank editor.
- **Leans into:** feature discovery (+ create-from-intent). Best for a new user learning the powers.

<br />

### 16 — Split Plane  (`variation-16-split-plane.html`)
**The online↔desktop split *is* the layout.** Two living planes: **left = ☁ Online** (the
TypeBuild queue that follows you to any machine, grouped by needs-you / working / unclaimed);
**right = ▣ This Mac** (the desktop-only abilities dock + a live stream of what's happening
*here* — Chrome paused for a y/n, files read/written). A full-width needs-you banner bridges both,
and **hairline cross-links** show where an online task reaches into the desktop. `h/l` switches planes.
- **Leans into:** online↔desktop split, made the spine of the page. The most explicit about
  "what travels with me vs what's anchored to this machine."

<br />

## How to react

For each, a quick gut read would help me converge:

- Which **lead surface** feels right for a home — a single Now card (13), a live feed (14),
  an ability launcher (15), or the two-plane split (16)?
- Is the **online ↔ desktop** distinction *legible* and *useful*, or noise? (14 and 16 push it hardest.)
- Does **feature discovery** belong on the home as a first-class dock/launcher (13, 15) or should
  abilities stay implicit and only show when in use (14, 16)?
- Is the **single focal point** ("what needs me now") landing, or competing with the rest?

<br />

## Reactions

<br />

### 13 — Now Board

*

<br />

### 14 — Agent Pulse

*

<br />

### 15 — Ability Launcher

*

<br />

### 16 — Split Plane

*

<br />

## Decision

*

<br />

<br />
