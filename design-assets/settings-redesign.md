# Settings redesign — card-based IA, keyboard-first, settings-scoped verbs

> Design-only deliverable for `task-3237cf5ae6ab`. No production React here — this
> documents the target IA, keyboard model, and the settings-scoped verb mechanism,
> grounded in the current code. A companion static mockup lives at
> [`settings-redesign-mockup.html`](settings-redesign-mockup.html).

---

## 1. Why redesign — what exists today

The current settings UI is a single modal dialog rendered directly by `App`
(`src/components/Settings.tsx:140-497`), opened via the `:settings` verb
(`src/components/ChipPrompt.tsx:1956-1974`, which fires `fm:openSettings`) or the
Statusbar Help/settings button. `App` owns the open state and an optional
`initialSection` (`src/App.tsx:115-119, 1205-1208, 1554`).

It is a **single-open accordion**: `openSection` holds at most one expanded
section (`Settings.tsx:33-35, 136-138`). Eight sections exist
(`Settings.tsx:11-19`):

| Section id | What it controls | Source |
| --- | --- | --- |
| `keybindings` | Every keybind, grouped by namespace prefix (`nav.*`, `goto.*`, …), inline-editable; "Reset to defaults" | `Settings.tsx:103-216` |
| `task-management` | Enable task management (checkbox) | `Settings.tsx:218-247` |
| `terminal` | "Open Terminal here" default app (select); "Use tmux" toggle | `Settings.tsx:249-304` |
| `chat-agent` | Default chat agent (select, from launchers) | `Settings.tsx:306-342` |
| `notifications` | Attention notify toggle; sound toggle; task-notification verbosity (select) | `Settings.tsx:344-404` |
| `claude-integration` | "Reset Claude integration" action + inline result | `Settings.tsx:40-63, 406-431` |
| `bookmarks` | Read-only list of `m`-bound bookmarks | `Settings.tsx:433-455` |
| `typebuild` | Enable TypeBuild; sign-in panel; side-by-side layout | `Settings.tsx:457-492` |

### Why the current layout is poor

1. **Not scannable.** A single accordion column means the user sees one open
   section and seven collapsed labels. There is no overview — you cannot tell at
   a glance what each section holds or what is currently set. The densest section
   (keybindings, dozens of rows across ~25 namespace groups) opens by default and
   dominates, burying the simple toggles.
2. **No real keyboard model.** The modal only wires **Escape → close**
   (`Settings.tsx:73-82`). Everything else is mouse-driven DOM tab order: you
   `Tab` through native `<button>`/`<select>`/`<input>` elements. There is no
   `j/k` motion, no card/field cursor, no way to jump between groups — a jarring
   break from the rest of the app, which is vim/ranger keyboard-first
   (`src/useKeyboard.ts`).
3. **Verbs don't change.** While the modal is open the ChipPrompt still offers
   the **folder/task** verbs (Move, Copy, Sort, Go to …). They are useless in
   settings and there is no `:theme` / `:reset` / `:export` surface for the
   things you actually do here. Settings is a context, but the command surface
   doesn't know it.
4. **Heterogeneous controls.** Raw `<select>`/`<input type=checkbox>` with
   ad-hoc `.settings__hint` text; no consistent row/field grammar, so the eye
   has to re-parse each section's layout.

The redesign keeps every setting and every backing action (dispatches,
`fm.*` bridge calls) — it only changes **layout, focus model, and the command
surface**.

---

## 2. Card-based information architecture

Replace the one-column accordion with a **two-pane settings surface**: a left
**rail of card groups** and a right **content pane** showing the focused group's
cards. This mirrors the chosen product direction (Project Atlas's calm
overview→drill model, `design-assets/inspirations/Reaction to inspirations.md:55`)
and the existing singleton-tab pattern (`projects` / `tasks`).

> **Recommended host: a singleton `settings` tab kind**, not a modal. The repo
> already has the precedent — `projects` and `tasks` are singleton tabs with their
> own `TabKind` (`src/types.ts:38`) and their verbs are gated by it. Hosting
> settings the same way is what makes the scoped-verb mechanism (§4) fall out for
> free. The modal can remain as a fallback, but the IA and keyboard model below
> assume the tab. Entering = open/focus the `settings` tab; leaving = switch back
> to any folder/tasks tab.

### Group rail (left)

Seven groups, each a rail entry with a glyph, label, and a **one-line summary of
current state** (so the overview is real, not just labels):

| # | Group | Glyph | Summary line (live) | Cards inside |
| --- | --- | --- | --- | --- |
| 1 | **General** | ◳ | "Dark · tmux off" | Theme, Window (maximize/fullscreen helpers) |
| 2 | **Keybindings** | ⌨ | "37 bound · 3 changed" | One card **per namespace group** (`nav`, `goto`, `find`, …) — see below |
| 3 | **Tasks** | ✓ | "Task mgmt on" | Enable task management; Task-notification verbosity |
| 4 | **Terminal** | ▤ | "iTerm · tmux off" | Default terminal; Use tmux toggle |
| 5 | **Agents** | ⚡ | "Default: Claude" | Default chat agent; launcher list (read-only link) |
| 6 | **Notifications** | ◖ | "Attention on · sound off" | Attention notify; Sound; Task notifications |
| 7 | **Integrations** | ⚙ | "TypeBuild signed in" | TypeBuild enable + auth + side-by-side; Claude integration reset; Bookmarks (read-only) |

This **regroups** today's eight flat sections into seven intent-named groups
(General is new; chat-agent→Agents; claude-integration + bookmarks fold into
Integrations). Nothing is dropped.

### Cards (right pane)

A **card** is a bordered plate holding 1–N **fields**. One field = one setting.
Visual grammar, consistent across every card:

```
┌─ Card title ───────────────────────────── (optional card action) ┐
│  Field label                         [ control ]                  │
│  one-line hint / current value                                    │
│  Field label                         [ ●——○ toggle ]              │
└──────────────────────────────────────────────────────────────────┘
```

- **Controls are normalized** to four field types: **toggle** (was checkbox),
  **picker** (was `<select>`; opens an inline option list, keyboard-navigable),
  **keybind** (press-to-capture, reusing today's `startEdit`/`saveEdit` logic,
  `Settings.tsx:116-130`), and **action button** (Reset defaults, Reset Claude
  integration, Sign in).
- **Keybindings** is the one dense group: render **one card per namespace**
  (`nav`, `goto`, `find`, …), each card a table of `action → keybind`. The
  existing grouping logic (`Settings.tsx:104-114`) already produces exactly these
  groups — reuse it; just promote each group to its own card so the user can
  jump between, say, `goto` and `tab` cards with `h/l` instead of scrolling one
  monolith.

### Visual hierarchy — design tokens (no new palette)

All values come from `src/styles/tokens.css`. Theme-safe text tokens
(`tokens.css:96-131`) are mandatory — never raw `--fg-1`/`--ink`.

| Element | Token(s) |
| --- | --- |
| Settings canvas (recessed plate) | `background: var(--bg)`; chrome rail on `var(--panel)` (framed invariant, `tokens.css:259-264`) |
| Card surface | `var(--panel-2)` with `border: 1px solid var(--rule-on-panel)`, `border-radius: var(--r-lg)` (10px), `box-shadow: var(--shadow-1)` |
| Card title | `font: var(--fs-md)/var(--lh-tight)`, `color: var(--text-on-panel)`, `letter-spacing: var(--tracking-tight)` |
| Group rail label | `var(--fs-sm)`, `color: var(--text-on-panel)`; summary line `var(--fs-xs)`, `color: var(--muted-on-panel)` |
| Field label | `var(--fs-md)`, `var(--text-on-panel)` |
| Hint / current value | `var(--fs-xs)`, `var(--muted-on-panel)`, `line-height: var(--lh-normal)` |
| Section / namespace caption | `var(--fs-xs)`, `text-transform: uppercase`, `letter-spacing: var(--tracking-caps)`, `var(--muted-on-panel)` |
| Focused card / field ring | `box-shadow: 0 0 0 2px var(--accent-glow)`; border → `var(--accent)`; transition `var(--motion-focus-ring)` |
| Toggle ON track | `var(--accent)`; knob `var(--text-on-accent)`; transition `var(--motion-toggle)` |
| Selected picker option | `background: var(--sel-bg)`, text `var(--sel-fg)` |
| Primary action button | `background: var(--accent)`, text `var(--text-on-accent)` (route through token — never assume `#fff`, `tokens.css:117-122`) |
| Destructive action (Reset Claude) | text `var(--err)`, ghost border |
| Rail/card gutters | `--sp-4` (16) between cards, `--sp-3` (12) field rows, `--sp-2` (8) label↔hint |
| Card enter (group switch) | `var(--motion-reveal)` (`tokens.css:80`); rail selection move `var(--motion-select)` |

Spacing rides the 4px grid (`--sp-*`, `tokens.css:36-44`); radii `--r-*`
(`tokens.css:45-49`); motion semantic tokens only (`tokens.css:72-90`). Reduced
motion is already handled globally (`tokens.css:567-587`).

---

## 3. Keyboard navigation model

Settings adopts the same **motion + cursor** mental model as the file panes, so
muscle memory carries over. Two cursors: a **group cursor** (rail) and a **field
cursor** (within the focused group's cards). A card is just a visual container —
the cursor lands on **fields**, walking across card boundaries.

### Motion (consistent with `useKeyboard.ts` vim motions)

| Key | Action |
| --- | --- |
| `j` / `↓` | Field cursor down (next field; crosses card boundaries) |
| `k` / `↑` | Field cursor up |
| `h` / `←` | Move focus to the **group rail** (back out one level) |
| `l` / `→` | Enter the content pane from the rail / move into a field's control |
| `J` / `K` (or `]`/`[`) | Jump to next/previous **card** (skip its inner fields) |
| `gg` / `G` | First / last field — mirrors the existing `goto.*` family |
| `n` / `N` | Next/prev **changed-from-default** field (parallels search next/prev) |
| `Tab` / `Shift+Tab` | Native fallback order (accessibility), kept working |

When the **rail** holds focus, `j/k` move the group cursor and `l`/`Enter`
dives into that group's first card; this is the overview→drill motion the rest
of the app uses.

### Edit / toggle / commit

| Key | On field type | Behavior |
| --- | --- | --- |
| `Enter` / `l` | toggle | Flip the toggle (dispatch immediately) |
| `Space` | toggle | Flip (matches Space=act elsewhere) |
| `Enter` / `l` | picker | Open inline option list; `j/k` move, `Enter` commit, `Esc` cancel |
| `Enter` | keybind | Enter **capture mode** — next chord is recorded (reuses `startEdit`→`saveEdit`, `Settings.tsx:116-130`); `Esc` aborts capture |
| `Enter` | action button | Run the action (e.g. Reset Claude integration) |
| `Esc` | (in capture/picker) | Cancel back to field cursor |
| `Esc` | (at field cursor) | Move focus to rail (`h`) — a second `Esc` from the rail leaves settings |

This keeps **Esc as the universal "back out"** the app already trains
(`Settings.tsx:73-82`, `useKeyboard.ts` Escape handling), but layers it: capture
→ field → rail → leave, rather than today's single jump straight to close.

### Focus presentation

The focused field shows the **accent ring** (`box-shadow: 0 0 0 2px
var(--accent-glow)`, border `var(--accent)`), animated with
`var(--motion-focus-ring)`. The focused **card** gets a subtler tint
(`var(--accent-soft)` left edge). The active **group** in the rail uses
`var(--sel-bg)` / `var(--sel-fg)` — the same selection language as file rows, so
"where am I" reads identically across the app. Exactly one ring is visible at a
time; `prefers-reduced-motion` collapses the transition (already global,
`tokens.css:567-587`).

---

## 4. Settings-scoped verb mechanism

**Goal:** entering settings switches the ChipPrompt's verb set to
settings-specific verbs, and leaving reverts to normal verbs — with no new
paradigm.

### It extends the existing `tabKinds` gate — verbatim

ChipPrompt already scopes verbs by the active tab's `TabKind`. The mechanism is a
single allowlist filter (`src/components/ChipPrompt.tsx:3257-3275`):

```ts
base = base.filter((v) => {
  if (v.tabKinds) return v.tabKinds.includes(activeTab.kind);   // allowlist when present
  if (inTasksTab || inTaskMode) return v.availableInTaskMode !== false;
  return true;
});
```

A verb with `tabKinds: ['tasks']` appears **only** on the Tasks overview tab; the
whole task-bulk verb family is built this way (`ChipPrompt.tsx:2256-2553`,
`buildTaskVerbs()`, each `tabKinds: ['tasks']`). `TabKind` is the enum to extend
(`src/types.ts:38`):

```ts
export type TabKind = 'folder' | 'task' | 'tasks' | 'edit' | 'browser' | 'projects';
//                                                                     add: | 'settings'
```

**The plan, concretely:**

1. **Add `'settings'` to `TabKind`** and host settings as a singleton
   `settings` tab (the recommendation in §2), exactly like `projects`/`tasks`.
   The `:settings` verb (`ChipPrompt.tsx:1956-1974`) stops firing a modal event
   and instead opens/focuses that tab (mirroring the `projects` verb,
   `ChipPrompt.tsx:1480-1491`).
2. **Define a `buildSettingsVerbs()` family**, each verb `tabKinds:
   ['settings']`, alongside `buildTaskVerbs()` (`ChipPrompt.tsx:2256`). Because
   the existing filter treats `tabKinds` as an allowlist, these verbs are
   **invisible on every other tab** — and because file/task verbs **omit**
   `'settings'` from their `tabKinds` (or set `availableInTaskMode`/leave it
   absent), they vanish the moment the `settings` tab is active. No extra branch
   needed: the line `if (v.tabKinds) return v.tabKinds.includes(activeTab.kind)`
   already does the gating.
3. **Reversion is automatic.** The verb set is `useMemo`'d on `activeTab.kind`
   (`ChipPrompt.tsx:3274`). Switch back to a folder/tasks tab (`gt`/`Ctrl+Tab`,
   or `:` then a folder verb) and `activeTab.kind` changes to `'folder'`,
   re-running the filter and restoring normal verbs. "Going back home" is just a
   tab switch — the same gesture that already swaps Tasks verbs out.

> Modal fallback: if settings stays a modal, mirror the gate with a
> `settingsOpen` flag in `Ctx` and one extra clause —
> `if (ctx.settingsOpen) return v.settingsVerb === true;` — but the tab approach
> reuses the proven path and is strongly preferred.

### Proposed settings verbs (the `:settings`-scoped catalog)

Each is a thin `VerbDef` with `tabKinds: ['settings']`. Verbs that map to an
existing field **dispatch the same store action / `fm.*` call** the field would;
verbs that move focus fire a `fm:settings:*` event the page listens for (the same
event-dispatch pattern `buildTaskVerbs` uses, `ChipPrompt.tsx:2256-2296`).

| Verb | Aliases | Slots | Does |
| --- | --- | --- | --- |
| `:theme` | theme, dark, light, appearance | `Which theme` (alpine/light/dusk/paper/…) | Apply theme (same path as today's existing theme verb / `data-theme`) |
| `:keybind` | keybind, bind, rebind, shortcut | `Action` → `Press keys` | Jump to that action's keybind card and enter capture (reuses `startEdit`/`saveEdit`) |
| `:reset-keys` | reset keys, defaults, reset binds | — (confirm) | `dispatch({type:'setKeybinds', keybinds:{...DEFAULT_KEYBINDS}})` — today's `resetAll` (`Settings.tsx:132-134`) |
| `:default-terminal` | terminal, term app | `Which terminal` | `fm.setDefaultTerminal(...)` — today's `onTerminalChange` (`Settings.tsx:84-101`) |
| `:default-agent` | agent, chat agent | `Which agent` (from launchers) | `dispatch({type:'setDefaultAgentId', …})` (`Settings.tsx:316-322`) |
| `:notifications` | notify, alerts | `Level` (all/failures/off) | `dispatch({type:'setTaskNotifications', …})` (`Settings.tsx:390-398`) |
| `:tmux` | tmux | — (toggle) | `dispatch({type:'setUseTmux', …})` |
| `:tasks-toggle` | enable tasks | — (toggle) | `dispatch({type:'setTaskManagementEnabled', …})` |
| `:typebuild` | typebuild, sign in, integration | — | Focus Integrations group / TypeBuild auth |
| `:reset-claude` | reset claude, unregister | — (confirm) | `fm.claudeUnregisterMcp()` + `fm.claudeUnregisterHooks()` — today's `resetClaudeIntegration` (`Settings.tsx:40-63`) |
| `:export-settings` | export, backup settings | `Where` | Write keybinds + prefs to a JSON file (new; calm "backup" affordance) |
| `:import-settings` | import, restore settings | `From` | Load a settings JSON and apply |
| `:goto-group` | go to, jump, section | `Group` (General/Keybindings/…) | Move the group cursor (fires `fm:settings:goto`) |
| `:close-settings` | close, back, done, home | — | Switch back to the prior tab (reverts the verb set automatically) |

These are **discoverable the normal way**: typing any letter opens the
ChipPrompt, which now lists only the settings catalog because the tab kind is
`'settings'`. `:help` and `:switchTab` remain available (they omit
`tabKinds`/opt into task mode, so the same filter keeps them
universal — `ChipPrompt.tsx:3267-3271`).

### Activation / reversion summary

- **Enter settings:** `:settings` (or its aliases `preferences`, `prefs`,
  `config`, `options`, `ChipPrompt.tsx:1958-1965`) → opens/focuses the
  `settings` tab → `activeTab.kind === 'settings'` → `effectiveVerbs` re-memoizes
  → only `tabKinds: ['settings']` verbs (+ universal ones) show.
- **Leave / "go back home":** switch to any folder/tasks tab (`:close-settings`,
  `gt`, `Ctrl+Tab`) → `activeTab.kind` flips → filter re-runs → normal verbs
  return. No teardown code; the existing memo dependency does it
  (`ChipPrompt.tsx:3274`).

---

## 5. What stays the same

- Every setting, dispatch, and `fm.*` bridge call from `Settings.tsx` is
  preserved — this is layout + focus + command-surface work, not a rewrite of
  the backing logic.
- The keybind grouping (`Settings.tsx:104-114`), edit/save (`116-130`), reset
  (`132-134`), terminal change (`84-101`), and Claude reset (`40-63`) are reused
  directly as the cards' field handlers and the settings-verb `execute` bodies.
- Tokens only (`src/styles/tokens.css`); theme-safe text tokens
  (`tokens.css:96-131`); global reduced-motion (`tokens.css:567-587`).
- `:help` / HelpTour: per the repo's help-maintenance rule, ship a "Settings
  mode" slide to `src/components/HelpTour.tsx` documenting the scoped verbs when
  this lands.
