# Shared builder brief — Breezefile task-experience inspirations

You are building ONE-FILE, low-fidelity-but-real HTML/CSS/JS design inspirations (Phase 3, CHAI
"Going Broad"). Breadth over polish. Each file opens in a browser with NO build step. Inline all
CSS/JS in the single .html file. No external fonts/CDNs except system fonts. No frameworks.

## The product
Breezefile — an Electron, keyboard-first file manager that grew into an agentic task manager.
Tasks are either **manual** (human to-dos: title, folder, notes, dates, pin) or **agentic**:
- **local auto** — Claude Code agent runs on a cron or on demand, in a folder
- **TypeBuild** — a SHARED, ENCRYPTED team queue: claim / assign / priority / attempts / deps.
Agentic tasks spawn Claude Code sessions (today: raw terminal tabs).

## The brief (what every variation must serve)
Primary user: a keyboard-first power operator PLUS a small team on the shared TypeBuild queue.
Push BOLD — reimagine beyond today's tabs/rows/detail-pane. The current page is CLUTTERED; keep the
critical functionality but make it SIMPLE and DELIGHTFUL — calm by default, powerful on demand.

Three jobs, priority order:
1. MONITOR running agents live — know which agents are working / waiting-on-me / blocked / done and
   their last action, in real time, WITHOUT opening terminals.
2. TRIAGE the overview — instantly see what needs me / what's moving / what's done; secondary
   controls one action away, not always on screen.
3. CREATE agentic tasks from INTENT — describe work in a sentence; system proposes agent/schedule/
   folder/steps and asks only what it can't infer; lead with templates/recipes + recently used.

## Values to honor (cite at least one per variation in an HTML comment at top)
V1 Calm Clarity · V2 Live Situational Awareness · V3 Direct Control · V4 Intent→Action ·
V5 Trust & Auditability · V6 Team Coordination · V7 Confidentiality (PHI: TypeBuild content is
encrypted, decrypted text is memory-only — show STATE freely, gate CONTENT behind an on-focus
reveal) · V8 Power Without Machinery (thin data + agent supplies control flow; no Jira machinery;
keep a fast keyboard path).

## Mandatory usability bar (each file must pass)
- Primary action obvious without reading supporting text.
- Every async/agent action has a visible loading/progress state.
- Empty states: explanation + next step + primary CTA.
- Nothing essential hidden in hover-only (hover may ENHANCE, not gate).
- Multi-step agent actions show a STEP-LEVEL execution trace with per-step status + one-line "why".
- Agent execution has a visible CANCEL/STOP.
- First-time-user default view works; advanced detail one action away.
- Irreversible / credit / resource-consuming actions show a preview/dry-run or inline estimate.
- Cross-surface transitions carry context forward.
- Agent errors say what happened, why, and what to do next.
- Creation flows LEAD WITH TEMPLATES, not a blank editor; surface recently-used.

## Content bar
- REAL, representative copy. NO lorem ipsum, NO grey placeholder boxes.
- Each primary screen carries a HERO INSIGHT that is directional, earned, specific — names a number,
  a task/agent, a timeframe. e.g. "3 agents are waiting on you. The deploy run has been blocked for
  41 min on a failing test — open it first." NOT "View your agent activity."
- Operator voice: clear not clever; bold not hedged; drives toward a decision.
- Represent the team: show >1 person owning work (e.g. "you", "Priya", "Sam") on TypeBuild items.

## Representative data to reuse across files (keep names/numbers consistent so the set feels coherent)
Running agents:
- "Nightly deploy" — local auto, BLOCKED 41 min on failing test `auth.spec.ts`, folder ~/git/api
- "Triage inbox → tasks" — TypeBuild, WORKING, claimed by you, last action "drafted 4 tasks"
- "Migrate beads → tasks" — local auto, WAITING ON YOU: "Delete 12 stale issues? (y/n)"
- "Refactor TaskRow" — TypeBuild, WORKING, claimed by Priya, step 3/5
- "Weekly report" — local auto cron Fri 9am, DONE 2h ago, "summarized 18 PRs"
Triage / to-dos:
- "Reply to landlord about lease" — manual, due today, pinned
- "Review Sam's PR #214" — manual, due today
- "Plan Q3 roadmap" — manual, no date
TypeBuild team queue: tasks owned by you / Priya / Sam; one "unclaimed: Fix flaky CI"; priorities P0-P3.
Templates/recipes for creation: "Ship a PR", "Nightly deploy", "Triage inbox", "Summarize a repo".

## Output
Write each variation as its own file in this folder. Use the EXACT filenames you were told to use.
Top of each file: an HTML comment listing the variation name, the paradigm, and the values it serves.
Make them visually distinct from each other (different layouts, not the same grid recolored).
