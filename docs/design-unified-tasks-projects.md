# Design: Unified Tasks + Projects surface (tasks-first home)

Epic: task-3ff338f80de5 — "unify Tasks + Projects."
Children covered: task-1bf3a297c9f9 (folder-aesthetic unified surface), task-eaa5e794f448 (tasks-first home redesign), task-9d54b7ab7972 (merge UIs), task-4b0168979921 (inbox alignment — shipped this session), task-6255239581b2 (attention).

Status: DESIGN — build-ready. No code in this doc. Grounded in the CURRENT `main` state (operator split-pane, verb registry / Cmd-K palette, online memory, credential capture, tagging Phase-2 LLM all already shipped).

> PHI: this doc uses NO real task titles/bodies. All examples below are invented placeholders ("Acme onboarding", "Refile claim").

---

## 0. What exists today (grounding)

The shell (`src/App.tsx`) renders ONE active tab in the main slot, branching on `tab.kind` (`src/types.ts` `TabKind = 'folder' | 'task' | 'tasks' | 'edit' | 'browser' | 'projects'`):

- `folder` → `FolderHeader` + `FilterChip` + `FolderList` (the file-manager surface; the editorial header + dense single-list rows).
- `tasks` → `TasksPage` (singleton; inbox list with FOR YOU / FOR AGENTS / DONE sections + a right `TaskDetailPanel`).
- `projects` → `ProjectsPage` (singleton; "Project Atlas" — an attention-ranked grid (L1) that drills into a per-project task tree (L2)). **Redesigned this session (task-4b0168979921) into the attention-ranked inbox; do not rework it.**

Launch surface: `store.tsx` `setHome` creates exactly one `makeTab(home)` **folder** tab on open (`makeTab` defaults `kind: 'folder'`). So **today the default home is the file manager.** That is the thing the epic flips.

Singletons: `openTasksTab` / `openProjectsTab` (store) focus-or-spawn one tab of that kind. Sidebar + Preview slots are suppressed for `tasks`/`projects` tabs (App.tsx lines ~1393, ~1460). The Tasks/Projects tabs carry fixed labels in `Tabbar.tsx`.

Verbs (`ChipPrompt.tsx`): `:tasks` (aliases `tasks`/`all tasks`/`task list`) → `fm:openTasksPage`; `:projects` (aliases `projects`/`atlas`/`project home`) → `fm:openProjects`; `:new-project` → `fm:openProjects` + create form. Tasks-tab verbs are gated `tabKinds: ['tasks']`; file verbs are hidden off folder tabs. **The `:project-task` verb is already GONE** — confirmed: no `project-task` / `projectTask` references anywhere in `src/` (the only hit is an unrelated comment in `electron/sources/typebuild.ts`). Project-scoped create now reuses the shared `TaskComposer` with `projectId` pre-selected (task-223d400ffc1a).

Composer (`TaskComposer.tsx`): `project` is already a first-class field (question order `['title','project','who','notes', …]`, task-ab1d7955e23f). `{ mode:'create'; defaultFolder; projectId? }` pre-selects a project; folder→project auto-attach already works. **This is the "one new-task flow" the epic asks for — it already exists.**

Attention (`src/projects/attention.mjs`): pure, NON-PHI. Per project it tallies open/blocked/overdue/failed, rolls UP through sub-projects, produces `{ total, score, lastActivityMs, idle }`. ProjectsPage already ranks by it. This is the engine the tasks-first home reuses.

File-manager visual language to adopt: `FolderList.tsx` (head row `[checkbox] name count`, then a `<ul class="folder-list__list">` of `FileRow`), `FolderHeader.tsx` (kicker · big serif title · italic dek · ❦ ornament), `FileRow.tsx` (dense `[disclosure][check][icon][name][meta][primary][kebab]`), `tokens.css` (type scale `--fs-*`, spacing `--sp-*` 4px grid, `--text-on-canvas`, `--accent`, motion tokens). `TaskRow.tsx` is ALREADY structurally a FileRow twin: `[connector][disclosure][check][dot+title+childprogress][sub-meta][primary][kebab]`.

---

## 1. Information architecture

### The single unified surface

There is ONE primary surface, **Home**, presented as a singleton tab. It has two reconciled modes that are the SAME component family, not two pages:

- **Home root (all-projects inbox):** the tasks-first landing. Reuses ProjectsPage's attention partition (attention / recent / idle) but renders each project as a **folder-style block** (header + its tasks listed beneath like files), NOT a card grid. This is the merge of "tasks-first home" (task-eaa5e794f448) and "folder-style projects" (task-1bf3a297c9f9) and the inbox ranking (task-4b0168979921 / task-6255239581b2).
- **Project view (drilled in):** a single project rendered exactly like a folder — `FolderHeader`-style header (project name + description + bound-folder kicker) with its tasks listed beneath as rows, and nested sub-projects shown as nested folder blocks. This is today's ProjectsPage L2, restyled to the file-manager language and made navigable like a folder trail (breadcrumb, `h`/`l`).

The mental model: **PROJECT = FOLDER, TASK = FILE.** Projects nest like sub-folders. A task always lives in exactly one project (its container), surfaced via the composer's project field. The breadcrumb is the project ancestor chain (`ancestorChain` / `breadcrumbPath` already exist in `src/projects/`).

### Default on app open

**RECOMMENDATION (needs Vivek decision — see §5, Q1):** On launch, open the **Home (tasks-first) singleton tab as the active tab**, and ALSO open a folder tab (current `home` dir) so file-manager muscle memory is one tab-click / `gh`-style verb away — but Home is what greets the user. Concretely: `setHome` keeps creating the folder tab, but we ALSO dispatch `openTasksHomeTab` and make IT `activeTab: 0`-equivalent (focused). The file manager "drops to one ability among many" by no longer being the thing you see first; it remains fully present as a tab + as the surface agents/the human use for file work.

### How the file-manager becomes "one ability"

Nothing is removed. The folder surface stays exactly as built (FolderHeader + FolderList). It changes from *the launch surface* to *a surface you navigate to* — via the existing `:files`/folder verbs, the Sidebar bookmarks, "Go to folder" from a task row (`rowGotoFolder` already exists), and "Reveal/Open" actions. The Home surface gains a clear affordance to jump into a project's bound folder (the folder binding shown in the project header becomes a click target → opens a folder tab).

### Three surfaces collapse to two tab kinds

- `tasks` and `projects` tab kinds MERGE conceptually into one **Home** surface. Implementation: keep ONE singleton kind (reuse `kind: 'projects'` as the host, OR introduce `kind: 'home'`; see §4 phasing — we reuse `projects` to avoid a new kind and a store/Tabbar/verb migration, and relabel it "Home"). The standalone `tasks` flat-list (`TasksPage`) is retained during migration as a fallback/secondary view ("All tasks" flat inbox) and folded in last (§4 Phase 5).
- `folder`, `task`, `edit`, `browser` are unchanged.

---

## 2. Layout & components

### Reuse vs. new

REUSED as-is:
- `tokens.css` — every new pixel uses existing `--fs-*`, `--sp-*`, `--r-*`, `--text-on-canvas`, `--muted-on-canvas`, `--accent`, `--accent-soft`, motion tokens. No new color/space primitives.
- `src/projects/*.mjs` — `buildProjectTree`, `indexTree`, `ancestorChain`, `breadcrumbPath`, `rollUpTaskStats`, `computeProjectAttention`, `attentionSummary`, `resolveEffectiveDescription/Instructions`. Pure foundation; do NOT rebuild.
- `attention.mjs` partition + ranking — drives section order on Home root (unchanged engine).
- `TaskComposer` — the one new-task flow (project field already present).
- `TaskDetailPanel` / `TaskDetailDrawer` — task detail, opened from any task row (already event-driven via `fm:openTaskDetail` / `fm:tasks:focus`).
- `useTaskActions`, `useTasks`, `useRunningSessions`, `primaryActionFor`, `partitionTasks` — task data + per-row primary action.
- `FolderHeader` markup/CSS classes (kicker / title / dek / ornament) — adopted by a new `ProjectHeader` that renders project name (title), description (dek), bound folder (kicker), and a task-count summary.

NEW (thin, presentational):
- `ProjectFolderBlock` — renders ONE project as a folder: a `ProjectHeader` + a `<ul class="folder-list__list">` of task rows beneath, plus nested `ProjectFolderBlock`s for sub-projects (indented like sub-folders). This is the heart of the "folder-aesthetic" half. It composes existing pieces; it does not invent a new visual language.
- `HomeSurface` (the renamed/reworked `ProjectsPageInner`) — owns the breadcrumb + keyboard model + the root-vs-drilled mode switch and renders `ProjectFolderBlock`(s).
- A shared `TaskFileRow` IF we choose to converge `TaskRow` (Tasks page) and the L2 tree row (ProjectsPage `trow`) onto ONE row component (recommended; see below). Lowest-risk path is to use the existing `TaskRow` for project task lists.

### Can a project render via the same row/header primitives as a folder?

YES.
- **Header:** `FolderHeader`'s structure maps 1:1 — kicker (`parent · Current folder · last modified`) → (`parent project · Project · N tasks · M need you`); big serif `folder-header__title` → project name; italic `folder-header__dek` → project description (the "◇ given to agents as context" mark moves here); `❦` ornament retained. Reuse the `folder-header__*` CSS classes directly so themes/paper palettes apply unchanged.
- **Rows:** `TaskRow` is already a FileRow-shaped dense row. Render project tasks with `TaskRow` inside `folder-list__list`. Sub-projects render as a nested folder block (or, when collapsed, as a single folder-like row with a `▸ N sub-projects · K need you` disclosure, mirroring `FileRow`'s dir affordance and `TaskRow`'s parent disclosure).

### Column model & density

Adopt the file list's density tokens. The unified row column model (one grid, used by both file rows and task rows so the surface reads as one app):

```
[ disclosure ][ check ][ status/type glyph ][ NAME (grows) ][ meta chips ][ PRIMARY ][ ⋮ ]
```

- File row glyph = file-type icon; task row glyph = `TaskStatusDot`. Same column slot, same width.
- Meta chips: files show size/mtime; tasks show who/due/claimed/blocked/run-count (already in `TaskRow`).
- Density: reuse `folder-list__list` row height + `--fs-sm`/`--fs-2xs` + `--sp-*` paddings. The Home root packs project blocks tight (header is `--fs-lg`/serif, not the full 58px folder hero — a "folder inside a list" scale, see ASCII below).

### Breadcrumb + keyboard nav reuse (j/k/l/h, gg/G, /)

ProjectsPage already implements `j/k` (move), `l/Enter` (drill / expand), `h/Esc` (back), `:` (palette). Extend to full file-manager parity so the surfaces share muscle memory:
- `j/k` or `↓/↑` — move cursor across the FLAT visible order (project headers + task rows + sub-project rows), exactly like FolderList walks entries.
- `l`/`Enter`/`→` — drill into the cursor item: project header → project view; sub-project → nested project; task row → open `TaskDetailDrawer` (leaf) or expand (parent).
- `h`/`←`/`Esc` — up one level (project view → parent project → Home root). Maps to FolderList's "parent" motion.
- `gg`/`G` — jump to first/last visible row (NEW for this surface; trivial — clamp cursor; matches folder nav).
- `/` — focus search/filter (TasksPage already binds `/` to open the filter bar; reuse).
- `Space` — toggle selection (for bulk task ops via `:` verbs — TasksPage already has this).
- `n`/`+ New task` — open the composer pre-scoped to the project in view (already wired).

Breadcrumb: reuse `projects__crumb` markup, fed by `breadcrumbPath(roots, projectId)`. At Home root it reads "Home"; drilled it reads "Home › Acme › Onboarding".

### ASCII mockup — unified surface

Home root (tasks-first landing; projects-as-folders, attention-ranked):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Home                                                  [⫶⫶ Filter] [+ New task]│
│  7 things need you, 2 blocked.  Open Acme onboarding first →                   │
├──────────────────────────────────────────────────────────────────────────────┤
│  Acme onboarding · Project · 5 tasks · ⚑ 3 need you      ⛓ ~/git/acme         │  ← ProjectHeader (folder-style), amber pill only when >0
│  Set up the new client end-to-end.  ◇ given to agents as context              │  ← dek (description)
│  ────────────────────────────────────────────────────────────────────── ❦    │
│   ● Refile claim 13402                  due Fri   ◆you      [ Start ]   ⋮      │  ← TaskRow (task = file)
│   ● Verify insurance                     blocked ⛓ waits 1  [ View ]   ⋮      │
│   ▸ Onboarding checklist     2/4 done            working   [ Open ]   ⋮      │  ← parent task, disclosure
│   ▸ Billing  (sub-project)   ▸ 3 tasks · 1 need you                    →      │  ← nested project, folder-style
├──────────────────────────────────────────────────────────────────────────────┤
│  Q3 reporting · Project · 2 tasks                        ⛓ ~/reports          │  ← next project block
│  ● Pull metrics                          due Mon            [ Run now ] ⋮      │
│  ─────────────────────── nothing needs you below ──────────────────────────   │  ← the fold
│  Personal · Project · 1 task                             no folder bound       │
│  ● Renew passport                        due in 30d        [ Start ]   ⋮      │
│                                            [ Show all projects (4 hidden) ]    │  ← idle projects collapsed
└──────────────────────────────────────────────────────────────────────────────┘
```

Drilled into a project (reads exactly like a folder; nested sub-project shown open):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Home › Acme onboarding                                            [+ New task]│  ← breadcrumb (ancestor chain)
│                                                                                │
│  kicker:  Home · Project · 5 tasks · 3 need you · last activity 2h ago        │
│  Acme onboarding                                                  ⛓ ~/git/acme │  ← big serif title (folder hero scale)
│  Set up the new client end-to-end.   ◇ given to agents as context             │  ← dek
│  ⚖ Instruction scopes · 8        ─────────────────────────────────────── ❦    │
│   ● Refile claim 13402                  due Fri   ◆you      [ Start ]   ⋮      │
│   ● Verify insurance                     blocked ⛓ waits 1  [ View ]   ⋮      │
│   ▾ Onboarding checklist     2/4 done            working                ⋮      │
│       └ ● Collect W-9                                       [ Start ]   ⋮      │
│       └ ● Send welcome packet            done                           ⋮      │
│   ▾ Billing  (sub-project)   ▸ 3 tasks · 1 need you                            │  ← nested project header inline
│       ● Send first invoice               due Wed           [ Start ]   ⋮      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Both views share the SAME row grid, density, tokens, breadcrumb, and keyboard model as `FolderList` — that is what makes it read as the same app.

---

## 3. The one new-task flow

Already in place; this design simply makes it the ONLY flow and documents the contract:

- `TaskComposer` opens via `fm:openTask` with `{ mode:'create'; defaultFolder; projectId? }`. The `project` field is question #2 (after title). None + every project, `↑↓`/digits to pick. (task-ab1d7955e23f, task-20d0051bf7b6.)
- From Home root or a project view, `+ New task` / `n` dispatches `fm:openTask` with `projectId` = the project currently in view (root → no preselect, or "None"). Existing `newProjectTask` in ProjectsPage already does exactly this.
- Folder-anchored create (from a folder tab) auto-attaches the owning project via the folder→project resolver — unchanged.
- `:project-task` verb: **already removed** (confirmed, §0). No separate project-task verb exists or should be re-added. HelpTour's "project task" catalog entry already documents "uses the SAME composer … there is no separate flow" — keep it, it is accurate.

No build work here beyond pointing the Home surface's create affordances at the existing event. This item is essentially DONE; Phase 3 just verifies + removes any stragglers.

---

## 4. Migration / phasing (ordered, dependency-aware, shippable)

Each step is one-agent-sized, names the files, and has an acceptance check. Steps are sequential unless noted.

### Phase 0 — Pre-flight verification (no UI change) — maps to epic task-3ff338f80de5
- WHAT: Confirm `:project-task` is gone; confirm composer `projectId` preselect works from a project; confirm `attention.mjs` + `src/projects/*` are the single source of ranking. Grep + a manual run.
- FILES: read-only (`ChipPrompt.tsx`, `TaskComposer.tsx`, `src/projects/`).
- ACCEPT: grep for `project-task` returns only the typebuild.ts comment; opening `+ New task` from a project preselects it.

### Phase 1 — `ProjectFolderBlock` + `ProjectHeader` (folder aesthetic) — maps to task-1bf3a297c9f9
- WHAT: New presentational components that render ONE project as a folder: `ProjectHeader` (reusing `folder-header__*` classes) + a `folder-list__list` of `TaskRow`s, with nested `ProjectFolderBlock` for sub-projects. No keyboard/IA change yet — render it inside the EXISTING ProjectsPage L2 in place of the bespoke `ptree`/`projects__l2head` markup.
- FILES: new `src/components/projects/ProjectFolderBlock.tsx` (+ `.css` reusing tokens), `src/components/projects/ProjectsPage.tsx` (swap L2 body to the new block), reuse `TaskRow.tsx`, `FolderHeader.css`.
- ACCEPT: drilling into a project shows folder-style header + task rows that visually match FolderList density (side-by-side screenshot parity on the `--fs-*`/`--sp-*` scale); nested sub-projects render as nested blocks.

### Phase 2 — Home root = projects-as-folders inbox (replaces L1 grid) — maps to task-9d54b7ab7972 + task-4b0168979921
- WHAT: Replace the L1 card grid with a vertical list of `ProjectFolderBlock`s (collapsed-by-default to header + top N tasks, or fully listed for attention projects), preserving the attention partition (attention / fold / idle + "Show all") from task-4b0168979921. Keep `computeProjectAttention` ranking and the hero line. Relabel the surface "Home"; keep `kind: 'projects'` as host (no new tab kind).
- FILES: `src/components/projects/ProjectsPage.tsx` (rework `ProjectsGrid` → `HomeRoot` list), `ProjectsPage.css`, `Tabbar.tsx` (label `projects` tab "Home"), `ChipPrompt.tsx` (`:home` alias on the `projects` verb; keep `:projects`/`:atlas`).
- ACCEPT: Home root lists projects as folder blocks, attention-ranked, with the fold + show-all behavior intact; `:home`/`:projects`/`:tasks`-home all land here.
- NOTE: aligns with, does NOT rework, task-4b0168979921 — the partition/ranking code is reused verbatim.

### Phase 3 — Default launch = Home (tasks-first) — maps to task-eaa5e794f448
- WHAT: On app open, focus the Home singleton as the greeting surface (keep a folder tab available but not active). Add `openProjectsTab`/`openHomeTab` to the launch path. **Gated on Vivek's Q1 answer** (replace vs. beside).
- FILES: `src/store.tsx` (`setHome` / launch effect — also open + focus Home), `src/App.tsx` (launch wiring if needed).
- ACCEPT: fresh launch shows Home with tasks-first content; the folder tab is one click away; muscle-memory verbs (`:files`, bookmarks) reach the file manager.

### Phase 4 — Keyboard + breadcrumb parity — maps to task-1bf3a297c9f9
- WHAT: Bring Home's keyboard model to full FolderList parity: flat `j/k` across project headers + task rows + sub-projects, `l/h/Enter/Esc` drill/back, add `gg/G`, `/` focuses filter, `Space` selects, `:` verbs act on selection. Breadcrumb via `breadcrumbPath`.
- FILES: `src/components/projects/ProjectsPage.tsx` (keyboard effect), reuse breadcrumb markup.
- ACCEPT: navigating Home with the keyboard feels identical to navigating a folder; breadcrumb reflects the ancestor chain.

### Phase 5 — Fold the flat "All tasks" list into Home — maps to task-9d54b7ab7972
- WHAT: Make the flat `TasksPage` inbox a VIEW within Home (a "flat / by-project" toggle) rather than a separate `tasks` tab — OR keep `:tasks` as a flat secondary view but route the default `tasks` entry through Home. Converge `TaskRow` and the L2 tree row onto one component if they have drifted.
- FILES: `src/components/TasksPage.tsx`, `src/components/projects/ProjectsPage.tsx`, `src/components/tasks/TaskRow.tsx`, `Tabbar.tsx`, `ChipPrompt.tsx`.
- ACCEPT: there is one Home; "All tasks" is a flat view of it; no orphaned second inbox. (Lowest-risk: defer fully merging the tab kinds; keep `tasks` reachable but make Home primary.)

### Phase 6 — Help + verb catalog update — maps to epic task-3ff338f80de5
- WHAT: Update `HelpTour.tsx` (the "projects"/"new-project"/"project task"/tasks slides) to describe Home, the folder aesthetic, the keyboard model, and "file manager is one ability." Update the verb catalog entries.
- FILES: `src/components/HelpTour.tsx`, `ChipPrompt.tsx` verb descriptions.
- ACCEPT: catalog matches shipped behavior (CLAUDE.md mandates HelpTour stays in sync).

Dependency order: 0 → 1 → 2 → 3/4 (parallelizable after 2) → 5 → 6. Phase 3 is the only one gated on a Vivek decision.

---

## 5. Risks & open questions (need Vivek decision — flagged for filing)

- **Q1 (LAUNCH SURFACE — primary decision).** Does tasks-first home REPLACE the file manager as the launch surface, or sit BESIDE it as a default-focused tab with the folder tab still auto-opened? Recommendation: BESIDE + Home focused (preserves file-manager muscle memory; lowest risk). Replace entirely is cleaner but strands users who launch to do file work.
- **Q2 (TAB KIND).** Reuse `kind: 'projects'` as the Home host (relabel) vs. introduce `kind: 'home'`? Recommendation: reuse `projects` to avoid a store/Tabbar/verb/`tabKinds` migration. Confirm you're OK with the internal name staying `projects`.
- **Q3 (FLAT INBOX FATE).** Keep the flat "All tasks" `TasksPage` as a secondary view inside Home, or retire it once projects-as-folders covers the same need? Affects Phase 5 scope. Recommendation: keep as a "flat view" toggle initially; retire later if unused.
- **Q4 (TASKS WITH NO PROJECT).** The vision says "every task belongs to a project," but the composer allows "None" and folder-anchored tasks may be project-less. Where do project-less tasks live on Home — a synthetic "No project" / "Inbox" block at top, or hidden from the folder view (only visible in the flat list)? Recommendation: synthetic "Inbox (no project)" block, always first. Needs a call.
- **Q5 (DENSITY OF NESTED PROJECTS).** Deeply nested projects (folder-in-folder-in-folder) on the Home ROOT could get tall. Collapse sub-projects to a single folder-row by default at root (expand to drill), full nesting only in the drilled project view? Recommendation: yes, collapse at root.
- **Q6 (HERO/FOLD COPY).** task-4b0168979921 just shipped the hero line + "nothing needs you below" fold + amber pill on the grid. Carrying these into a list layout is a copy/placement decision — confirm the fold divider and the single hero line still read right in the folder-list form (ASCII above assumes yes).
- **Risk — task timestamps.** `attention.mjs` already documents that TypeBuild's list endpoint stamps `now()` (no real per-task timestamps), so idle-hiding only works for sources that carry real stamps. The Home "last activity" kicker inherits this caveat — show it only when a real (above-floor) timestamp exists, else omit. No new work, but build agents must not invent a recency display that the data can't back.
- **Risk — singleton focus churn.** Making Home the default + auto-opening a folder tab means two singletons race on launch; sequence the dispatches so Home ends up `activeTab` deterministically (store reducer order).

---

## 6. Cross-platform

No OS-coupled concerns introduced. This epic is pure renderer/UI: it recomposes existing React components (`ProjectsPage`, `TasksPage`, `FolderHeader`, `TaskRow`), reuses pure `src/projects/*.mjs`, reads tasks via the existing `useTasks`/bridge, and adds no `process.platform`, no new `PlatformAdapter` capability, no OS app-launch / volumes / window-chrome / sound calls. Per CLAUDE.md and `docs/cross-platform-strategy.md`, `process.platform` must stay out of the renderer anyway; nothing here needs it. The "open project's bound folder" affordance routes through the EXISTING folder-tab open path (`rowGotoFolder` / `openOrFocusFolderTab`), which is already cross-platform. No verb gains a `requires: '<capability>'`. Confirmed clean.
