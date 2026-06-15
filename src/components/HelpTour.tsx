/*
 * HelpTour — slide-based help. Click "Help" in the status bar, run
 * the `:help` verb, or dispatch `fm:openHelp` with an optional
 * { slide: <id> } payload to land on a specific slide.
 *
 * Slide IDs are stable strings (see SLIDE_INDEX). Use them when wiring
 * deep-links from empty states or other surfaces:
 *
 *   window.dispatchEvent(new CustomEvent('fm:openHelp', { detail: { slide: 'tasks-intro' } }));
 *
 * MAINTENANCE: every time we add a new feature or verb, this file gets
 * an update. Add a row to the right slide's verbs array (or add a new
 * slide if it's a new category). See CLAUDE.md.
 */

import { useEffect, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { useIsMac, fmtKeys } from '../platform';
import { fm } from '../bridge';
import './HelpTour.css';

export type HelpSlideId =
  | 'value'
  | 'verbs'
  | 'navigate'
  | 'select'
  | 'share'
  | 'view-sort'
  | 'tags'
  | 'tasks-intro'
  | 'tasks'
  | 'tasks-auto'
  | 'remote'
  | 'tabs';

declare const __APP_VERSION__: string;

function cmpVersion(a: string, b: string): number {
  const norm = (v: string) =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const da = A[i] ?? 0;
    const db = B[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

type VerbItem = { name: string; chord?: string; what: string };
type CatalogSlide = {
  kind: 'catalog';
  id: HelpSlideId;
  section: string;
  glyph: string;
  title: string;
  lede: string;
  verbs: VerbItem[];
};
type NarrativeSlide = {
  kind: 'narrative';
  id: HelpSlideId;
  section: string;
  glyph: string;
  title: string;
  body: React.ReactNode;
};
type Slide = CatalogSlide | NarrativeSlide;

const SLIDES: Slide[] = [
  {
    kind: 'narrative',
    id: 'value',
    section: 'Welcome',
    glyph: '✦',
    title: 'Find files. Move them. Send them.',
    body: (
      <>
        Get anywhere in your files by typing. Then drag any file straight into
        a Slack message, a Gmail draft, or a web upload field —{' '}
        <b>no saving, no re-uploading</b>.
      </>
    ),
  },
  {
    kind: 'narrative',
    id: 'verbs',
    section: 'Welcome',
    glyph: '⌘',
    title: 'Type the action you want.',
    body: (
      <>
        Type <kbd>copy</kbd>, <kbd>move</kbd>, <kbd>tag</kbd>, or{' '}
        <kbd>share</kbd>. A small panel shows your choices. Pick one, hit{' '}
        <kbd>↵</kbd>. Every action works the same way — nothing to memorize.
      </>
    ),
  },
  {
    kind: 'catalog',
    id: 'navigate',
    section: 'Files',
    glyph: '↕',
    title: 'Navigate & find',
    lede: 'Move the cursor; jump anywhere; search across folders.',
    verbs: [
      { name: 'cursor', chord: 'h j k l', what: 'left / down / up / right (or arrows)' },
      { name: 'open / parent', chord: '↵ / ⌫', what: 'enter folder / go up' },
      { name: 'top / bottom', chord: 'gg / G', what: 'first or last row' },
      { name: 'history', chord: 'H / L', what: 'back / forward' },
      { name: 'find', chord: '⌘F or /', what: 'recursive search across folders + Spotlight' },
      { name: 'go to / find', what: 'type a folder OR file name in the chip prompt — folder picks navigate, file picks open the file in its default app' },
      { name: 'goto home', chord: 'gh', what: 'jump to ~ (also g/, ge, gu, gd, gp…)' },
      { name: 'quick find', chord: 'f', what: 'jump to a row by typed prefix' },
    ],
  },
  {
    kind: 'catalog',
    id: 'select',
    section: 'Files',
    glyph: '☐',
    title: 'Select & manage files',
    lede: 'Mark with space, then act. Or run a verb directly on the cursor row.',
    verbs: [
      { name: 'mark / all', chord: 'space / ⇧space / ⌘A', what: 'toggle one / select every visible row' },
      { name: 'select', what: 'smart filters: images, videos, by extension, folders only…' },
      { name: 'copy / cut', chord: '⌘C / ⌘X', what: 'stage files for copy / move; floating chip follows you to the destination' },
      { name: 'paste here', chord: '⌘V or ph', what: 'commit the staged copy/move (po, pl, phl variants)' },
      { name: 'rename', chord: 'F2 or cw / a / A / I', what: 'whole / before-ext / append / prepend' },
      { name: 'trash / delete', chord: 'dD / dF', what: 'send to Trash / permanent delete' },
      { name: 'create', chord: 'F7 or :touch', what: 'new folder / new file' },
      { name: 'duplicate', what: 'right-click → Duplicate' },
    ],
  },
  {
    kind: 'catalog',
    id: 'share',
    section: 'Files',
    glyph: '↗',
    title: 'Open, share, drag out',
    lede: 'The drag-out is the whole reason this app exists.',
    verbs: [
      { name: 'open', chord: '↵', what: 'open with default app' },
      { name: 'open with…', what: 'pick an app; optionally bind it as default for that extension' },
      { name: 'drag out', chord: 'd or drag', what: 'drag any row (or selection) to Slack, Gmail, Finder, anywhere' },
      { name: 'share', what: 'native macOS share sheet (Mail, Messages, AirDrop, …)' },
      { name: 'copy path', chord: 'yp / yn / yd', what: 'full path / name / parent dir to clipboard' },
      { name: 'reveal', chord: 'R', what: 'reveal in Finder' },
      { name: 'open terminal', what: 'launch your default terminal in this folder' },
      { name: 'edit', what: 'open the file in a new in-app edit tab — markdown renders WYSIWYM via Milkdown (h1/strong/list styled by your theme; markers disappear as you type), other text gets a plain editor · ⌘S saves atomically · the tab title shows • when there are unsaved changes and closing prompts before discarding' },
    ],
  },
  {
    kind: 'catalog',
    id: 'view-sort',
    section: 'Files',
    glyph: '▦',
    title: 'View & sort',
    lede: 'Switch how the folder reads, sort by anything, change the look. Choices stick — the next time you open this folder, your sort/view/hidden/folders-first settle back to what you last picked here.',
    verbs: [
      { name: 'view', chord: 'wl / wg / wp / wt', what: 'list / grid / preview / tag' },
      { name: 'sort', chord: 'on / os / om / oc / ot / oe', what: 'name / size / mtime / ctime / type / ext (caps for desc, or for reverse)' },
      { name: 'hidden', chord: '⌘⇧.', what: 'show / hide dotfiles (sticks per folder)' },
      { name: 'folders first', chord: 'zd', what: 'pin folders to the top (default) or interleave with files — turn off in Downloads to see newest items without folders crowding the top' },
      { name: 'theme', chord: 'zT', what: 'cycle dark/light; or :theme for the full picker' },
    ],
  },
  {
    kind: 'catalog',
    id: 'tags',
    section: 'Tags',
    glyph: '◐',
    title: 'Tags — color, group, filter',
    lede: 'Press wt to enter Tag view. Tags are rules over file metadata.',
    verbs: [
      { name: 'tag view', chord: 'wt', what: 'replaces preview with the tag inspector' },
      { name: 'apply HUD', chord: 't', what: 'in tag view: type to find a tag, ↵ to add or remove on the whole folder' },
      { name: 'newtag', what: 'create a tag with a rule (extension / size / modified / name) or manual-only' },
      { name: 'tag / untag', what: 'add or remove a tag from every file in this folder (verb form)' },
      { name: 'filter', what: 'narrow the folder to files carrying selected tags · Match all / Match any' },
      { name: 'access keys', what: 'each tag gets a single letter (r=Recent, l=Large, i=Images…) shown in the inspector' },
    ],
  },
  {
    kind: 'narrative',
    id: 'tasks-intro',
    section: 'Tasks',
    glyph: '✓',
    title: 'Tasks: a list, or an agent that runs it.',
    body: (
      <>
        Tasks are folder-anchored to-dos. Type <kbd>task</kbd> in any folder
        to add one. Two ways to use them:
        <br /><br />
        <b>By hand</b> — keep a list of what you owe each folder. Open the
        Tasks tab with <kbd>tasks</kbd>, mark them done as you go.
        <br /><br />
        <b>On a schedule</b> — flip <b>⚡ Auto</b> on a task and an AI agent
        (Claude Code today; Codex / Gemini coming) runs it for you when it's
        due. Every run is logged with status, duration, and a resumable trace.
        <br /><br />
        Next two slides: everyday use, then automation.
      </>
    ),
  },
  {
    kind: 'catalog',
    id: 'tasks',
    section: 'Tasks',
    glyph: '✓',
    title: 'Everyday tasks',
    lede: 'Create, view, and act on tasks. Most days you live in the Tasks tab.',
    verbs: [
      { name: 'task', what: 'open the inline composer · type a title and ↵ to save · ⇥ walks into the detail pills (folder · when · executor · auto), ↑/↓/↵ pick within a pill, ⌘. skips a pill, esc cancels · same composer handles edit, pre-filled with all current values · a Details panel below the four questions exposes status, start date, pin, notes, and (for Claude tasks) an agent-prompt override' },
      { name: 'tasks', what: 'open the singleton Tasks tab — split layout (list + detail panel) organized by OWNER: FOR YOU (manual tasks you act on by hand) · FOR AGENTS (TypeBuild + auto-execute tasks) · DONE (collapsed, most-recent first) · one filter row: search, Show done, Mine (only TypeBuild tasks you’ve claimed — local tasks unaffected), source dropdown (All / Breeze / TypeBuild), + New task · checkbox + arrow-key selection, all bulk actions via verbs' },
      { name: 'one primary action', what: 'every row shows exactly ONE primary button for what to do next — ✓ Done (manual) · ↺ Reopen · ▸ Start (TypeBuild) · ▸ Run now (auto) · ⧉ Open session (when a live session tab exists) · ◷ View run — everything else (pin, edit, open tab, status, due presets, go to folder, release, mark complete, cancel, reopen, delete) lives in the ⋮ kebab · a task someone else holds shows ◆ claimed by {who} and no action' },
      { name: 'tasks-tab verbs', what: 'chip prompt swaps in: :done :reopen :in-progress :cancel · :pin :unpin · :due / :start (Today / Tomorrow / Friday / Next week / Pick…) · :open task tab · :terminal · :claude / :codex / :gemini · :edit · :goto-folder · :delete · :sort · :show-completed · :select all/none/invert/overdue/pinned · (:group is gone — tasks are grouped by owner now)' },
      { name: 'tasks-tab keys', what: '↑/↓ or j/k move cursor · Shift+↑/↓ extend selection · Space toggle select · Enter edit (manual) / focus detail (agent) · / focus search · [ / ] snooze due ∓1 day · w snooze due +7 days (snooze only acts on editable rows)' },
      { name: 'detail panel', what: 'the right pane shows the cursor task: manual tasks get dates, status chips, and notes that COLLAPSE past ~8 lines with a Show more expand + inner scroll (long notes are finally readable) · TypeBuild tasks lazy-load their decrypted body on focus (held in memory only, never logged) plus a lifecycle block (status, claimed-by, attempts) with an editable Assignee (pick a teammate from the registry, or Unassigned) and a − N + Priority stepper, and the lifecycle verbs: Release (when you hold the claim) · Mark complete + Cancel (while the task is still open) · Reopen (for a done/partial/cancelled/failed/blocked task — reopening resets attempts and clears the last error) · Delete… (creator-only — a task you don’t own, or one in progress elsewhere, declines with a reason) · a collapsed History section that lazy-loads the task’s audit trail (who did what, when) on expand' },
      { name: 'remote sources', what: 'first turn on Settings → TypeBuild → “Enable TypeBuild” (off by default; the choice persists) — that reveals the sign-in, onboarding checklist, and side-by-side settings, and lights up a sign-in indicator in the left sidebar (a “TypeBuild · signed out” banner near the top whenever you’re signed out, plus a green/red TB status chip on the Active Tasks header) so you always know your session state · then one “Sign in” button opens your browser to the TypeBuild page, where you sign in with Google or email & password; the session comes back into the app automatically — and its tasks appear under FOR AGENTS · titles/bodies stay in memory, never written to disk (PHI-safe); you can reassign, set priority, and delete a TypeBuild task you created · a failed/partial/blocked source status shows as a badge next to the title · the due-date pill shows for TypeBuild tasks too, and a deferred (snoozed) task shows a “deferred until <date>” pill · the ⋮ kebab carries Release (when you hold the claim), Mark complete, Cancel, Reopen, and Delete… · if a source can’t be reached the status line shows “tasks from TypeBuild unavailable: …” rather than silently emptying the list' },
      { name: 'Start a TypeBuild task', what: '▸ Start claims the task for you AND opens a Claude session in a new tab, pre-wired to the task — there is no separate Claim button anymore · you never type a command and the session starts already authenticated (no /mcp sign-in prompt) · enabled only when you’re signed in and the onboarding prerequisites pass (Settings → TypeBuild: Claude Code + Chrome); the disabled tooltip says what’s missing · Start on a task someone else grabbed shows an inline “couldn’t start · claimed by X” and spawns nothing · if Breeze can’t mint the session token, Start says why (sign in again / can’t reach TypeBuild / access changed) and no tab opens · once a session is open, that row’s primary action becomes ⧉ Open session (focus the tab) instead of a second Start · Release lives in the ⋮ kebab and when the session ends while you still hold the claim a prompt offers Release · the secure session token lasts ~8h and can’t refresh mid-session — Breeze warns before it expires and offers a one-click “Restart task” at expiry · PHI-safe — the tab is labelled generically and terminal scrollback is never written to disk' },
      { name: ':sidebyside', what: 'verb (aliases split/chrome/arrange): toggle the TypeBuild side-by-side layout — Google Chrome snaps to the left (default 67% of the work area, configurable in Settings → TypeBuild), Breezefile to the right remainder, so you watch Claude drive the browser while you approve here · toggling off restores Breezefile’s previous bounds · auto-enters when a TypeBuild session starts (Settings toggle, on by default) and exits when the session’s tab closes · Chrome positioning needs Accessibility on macOS / wmctrl or xdotool on X11; on Wayland or without a grant it degrades to snapping only Breezefile’s window (snap Chrome yourself)' },
      { name: 'Schedule a remote task', what: 'TypeBuild has no scheduler, so Breezefile can fire a remote task on a LOCAL cron · the ⋮ kebab on a TypeBuild row offers Schedule… — pick Daily 9am / Weekdays 9am / Hourly or type a custom 5-field cron (validated inline); an active schedule shows as a ⏰ pill on the row · when it fires, Breezefile runs the task interactively (same as ▸ Start) — so the app must be open and signed in; if it can’t (signed out / app closed / token mint fails) the schedule rolls forward and a notification nudges you to open Breezefile and sign in (PHI-safe — only an opaque short id is shown, never the title) · the overlay is PHI-free: it stores only the opaque task id + cron, never the title/body · caveat: a session left at the approval gate past TypeBuild’s 2h claim TTL can lose its claim to a teammate · stale schedules (task done/deleted server-side) prune themselves' },
      { name: 'task tab', what: 'tabs bound to a task swap to a focused shell: prominent header, Open Terminal + Claude/Codex/Gemini + Rerun buttons · launching an AI pre-types the task context into the prompt, sets BREEZE_TASK_ID, drops a sidecar at ~/.breezefile/active-tasks/<id>.md' },
      { name: 'run anywhere', what: 'every folder tab has a Run a task ▾ button in its pathbar (next to sort/find), or type :run in the chip prompt · tasks for this folder appear first, then folder-agnostic ones · runs use the active folder as cwd' },
    ],
  },
  {
    kind: 'catalog',
    id: 'tasks-auto',
    section: 'Tasks',
    glyph: '⚡',
    title: 'Automation & runs',
    lede: 'Schedule a task, an agent runs it, every run is logged and resumable.',
    verbs: [
      { name: 'auto-execute', what: 'flip ⚡ Auto on a task and a registered agent (Claude Code first) runs it headlessly when due · scheduler retries on rate / usage errors and notifies on terminal failure · concurrent runs for the same task are refused server-side' },
      { name: 'recurrence', what: 'pick Daily 9am / Weekly Mon 9am / Custom cron… (raw 5-field expression) in the task composer · next_run_at recomputes after every successful run and clears when you mark the series done' },
      { name: 'run on save', what: 'agent-only When option that fires the task immediately after you create it · no cron, no schedule — one-shot kickoff' },
      { name: 'agent flags', what: 'on a Claude task the composer offers flags: Interactive (run opens in a new tab with an embedded claude session you converse and approve in, instead of headless), Chrome (let claude drive a browser, --chrome), Auto-accept (permissive edits, still human-gated) · an interactive cron fire opens a tab and pings you at the approval gate when the GUI is running; headless breezed falls back to a headless run' },
      { name: 'sidebar indicators', what: 'Active Tasks sidebar shows per-task glyphs: due-now dot, running spinner, last-run-failed dot, ⚡ for auto · an unseen-update badge on the Active Tasks header counts run completions + remote task changes you haven’t looked at, clearing when you open the Tasks page · right-click for Edit / Mark done / Pin / Snooze / Run now / View run history / Open last run in new tab / Delete' },
      { name: 'task notifications', what: 'Settings → Notifications → Task notifications picks how loud task events are: All (run successes/failures + remote TypeBuild changes), Failures only, or Off · a manual Run now stays quiet while a Breeze window is focused (you’re watching) but notifies if you tabbed away · remote-task notifications are PHI-safe — only an opaque short id, never the title' },
      { name: 'run history', what: 'every auto run lands in a per-task history dialog: status, duration, attempt, conversation_id · Rerun button starts a fresh run · "Open run" spawns a new tab with an embedded terminal and auto-runs `claude --resume <id>` so you land directly in the trace' },
      { name: 'runs view', what: 'on the Tasks tab toggle from Tasks → Runs to see every recent run across every auto task in one feed · filter by status, search by title or folder, click a row to jump into that task’s history' },
      { name: 'breeze CLI', what: 'a Node `breeze` shell command talks HTTP to the running app · `breeze status`, `breeze task list / show / add / edit / done / pin / unpin / delete / open`, `breeze open <folder>`, `breeze tabs` · <id> defaults to $BREEZE_TASK_ID inside task tabs · `breeze prime` (auto-installed Claude Code hook) feeds session context on start' },
      { name: ':remote-attach', what: 'verb (palette / chip prompt; aliases connect/attach): pick a host from your active sshfs mounts to connect it as a task SOURCE · the app installs + starts a persistent breezed daemon there (systemd --user, survives disconnect + reboot) and opens a forward ssh tunnel · that machine’s tasks appear under their own "<host>" section (group Tasks by Source) · creating a task in a folder under that host’s mount auto-routes it to that machine’s store with the real remote path · each machine owns + runs its own tasks (no sync) · "Connected hosts" in the sidebar lists them with a × to disconnect' },
      { name: ':disconnect', what: 'verb (aliases detach/drop-host): pick a connected remote host to disconnect it — tears down the forward tunnel and removes its task section (the host’s breezed keeps running there). Same as the sidebar × · the row flashes red briefly so you see it go' },
    ],
  },
  {
    kind: 'narrative',
    id: 'remote',
    section: 'More',
    glyph: '⇄',
    title: 'Remote machines',
    body: (
      <>
        Browse remote files locally via an <b>sshfs / macFUSE</b> mount, and
        Breeze will automatically run terminals, Claude, and other launchers
        on the <b>remote host</b> — not through the slow FUSE layer. Status
        hooks (busy / idle / needs-input) tunnel back so tab indicators and
        notifications work just like local sessions.
        <br /><br />
        <b>Prereqs.</b> Passwordless ssh to the host (a key in your agent,
        an entry in <code>~/.ssh/config</code> so <code>ssh &lt;alias&gt;</code>
        just works) plus an sshfs/macFUSE mount. Then anything under that
        mount is "remote-aware".
        <br /><br />
        <b>Linux quick setup.</b>
        <br />
        <code>sudo apt install sshfs</code> · add to{' '}
        <code>~/.ssh/config</code>:
        <br />
        <code>Host myserver</code><br />
        <code>&nbsp;&nbsp;HostName example.com</code><br />
        <code>&nbsp;&nbsp;User vivek</code><br />
        <code>&nbsp;&nbsp;IdentityFile ~/.ssh/id_ed25519</code><br />
        <code>&nbsp;&nbsp;ServerAliveInterval 15</code><br />
        Then mount:{' '}
        <code>mkdir -p ~/remotes/myserver &amp;&amp; sshfs myserver:/home/vivek
        ~/remotes/myserver -o reconnect,ServerAliveInterval=15</code>
        <br /><br />
        <b>macOS quick setup.</b>
        <br />
        Install <code>brew install --cask macfuse</code> and{' '}
        <code>brew install gromgit/fuse/sshfs-mac</code> (or use FUSE-T as an
        alternative). Approve the macFUSE kernel extension in System
        Settings → Privacy & Security on first install. The{' '}
        <code>~/.ssh/config</code> + mount commands are identical to Linux.
        <br /><br />
        <b>How Breeze uses it.</b> When you open a terminal or launch Claude
        in a folder under a remote mount, Breeze rewrites the spawn into{' '}
        <code>ssh -t &lt;target&gt; …</code> and translates the path to the
        remote root. On first connection per host, Breeze installs a small
        status-hook script on the remote (needs <code>python3</code> — present
        on every modern Linux/macOS by default). After that, hooks run
        on every Claude turn.
        <br /><br />
        <b>Escape hatches.</b> Set <code>BREEZE_REMOTE_DISABLE=1</code> in
        the environment to force local spawns everywhere. Drop a{' '}
        <code>.breeze-remote-skip</code> file at a specific mountpoint to
        opt out per-mount (useful if a mount is read-only or you want to
        edit locally on purpose).
        <br /><br />
        <b>Tasks per machine.</b> Run <code>:remote-attach</code> (alias{' '}
        <code>connect</code>) and pick a host from your active sshfs
        mounts. The app installs and starts a persistent{' '}
        <code>breezed</code> daemon there (a <code>systemd --user</code>{' '}
        service that survives disconnect and reboot) and opens a forward
        ssh tunnel. That machine <b>owns and runs its own tasks</b> — its
        task list shows under its own <b>"{'<host>'}"</b> section (group
        the Tasks page by <b>Source</b>); there is no sync or merge. A
        task you create in a folder under that host's mount is
        auto-routed to that machine's store, anchored to the real remote
        path. The host's own breezed fires its scheduled / auto tasks
        24/7 even when your laptop is closed. The sidebar's{' '}
        <b>Connected hosts</b> lists each connection with a × to
        disconnect; connected hosts reconnect automatically on next
        launch. Local recurring / auto tasks still need no launchd or
        systemd — the scheduler runs in-process, identical on Linux and
        macOS while Breeze is open.
        <br /><br />
        <b>Troubleshooting.</b> Check{' '}
        <code>~/.breezefile/claude-hook.log</code> on the remote: if posts
        show <code>http=000</code> the reverse tunnel didn't come up — run{' '}
        <code>ssh -v &lt;alias&gt;</code> to debug auth. If hook installation
        fails, ensure <code>python3</code> is on the remote's login{' '}
        <code>$PATH</code>.
      </>
    ),
  },
  {
    kind: 'catalog',
    id: 'tabs',
    section: 'More',
    glyph: '⊞',
    title: 'Tabs, terminals, the rest',
    lede: 'Live across many folders at once; mark places to return to.',
    verbs: [
      { name: 'new tab', chord: 'gn', what: 'open current folder in a new tab' },
      { name: 'switch / close', chord: 'gt / gT / gw', what: 'next / prev / close · ga restores last closed' },
      { name: 'jump to tab N', chord: '⌘1 … ⌘9', what: 'each tab shows its number — folder zone numbered first, then task zone' },
      { name: 'bookmark', chord: 'm<k> / \'<k>', what: 'set / jump (m a then \'a)' },
      { name: 'pin', what: 'pin a folder to the sidebar Favorites' },
      { name: 'shell', chord: '! / s', what: 'run a one-off command in this folder' },
      { name: 'term', what: 'open an embedded terminal pane rooted at this folder · :term-close to dismiss · drop files (from Finder, web pages, or Breeze rows) onto the pane to paste their absolute paths into the running shell / Claude Code prompt · select text and right-click → Copy, or use the platform copy shortcut (Cmd+C on macOS, Ctrl+Shift+C on Linux since plain Ctrl+C is SIGINT) · right-click the pane: with text selected → Copy (+ Open URL when the selection is a link); with nothing selected → Open ▸ Open folder / Open With… on the pane\'s working directory · theme-aware ANSI palette with a minimum contrast floor so colors stay readable on every theme' },
      { name: 'claude / codex / gemini', what: 'open the terminal pane and launch the AI CLI · when the launcher has variants the verb gains a Flags slot — Space toggles each flag (e.g. Continue, Skip-permissions), Enter launches with the union (no flags = bare) · backgrounded tabs badge red when the agent is waiting for you (turn end OR mid-turn permission prompt) · dock badge + Ping sound + system notification when Breeze is in the background (per-channel toggles in Settings → Notifications)' },
      { name: 'open-terminal', chord: 'cli', what: 'open an external terminal app (iTerm, Warp, …) at this folder' },
      { name: 'compress / extract', what: 'zip a selection · expand an archive' },
      { name: 'settings', chord: '?', what: 'view & rebind keys · per-launcher settings · notification channels · Reset to defaults' },
      { name: 'permissions', what: 'see which protected folders Breeze can read; grant any still missing' },
      { name: 'upgrade', what: ':upgrade runs brew upgrade --cask breezefile and relaunches · the help dialog also surfaces an "Update available" banner when a newer release is out' },
    ],
  },
];

function indexOfSlide(id: HelpSlideId | undefined): number {
  if (!id) return 0;
  const idx = SLIDES.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : 0;
}

export function HelpTour({
  onClose,
  initialSlide,
}: {
  onClose: () => void;
  initialSlide?: HelpSlideId;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const isMac = useIsMac();
  const [i, setI] = useState(() => indexOfSlide(initialSlide));
  const [pendingUpdate, setPendingUpdate] = useState<{ tag: string } | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  const isLast = i === SLIDES.length - 1;

  // Second-chance nudge: if a newer release exists on GitHub, surface it
  // at the top of the help dialog. UpdateChip also shows this, but users
  // who dismissed it (or haven't seen it yet) land here when they open
  // Help — a natural place to discover the :upgrade verb too.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fm.checkUpdate();
        if (cancelled || !r) return;
        if (cmpVersion(r.version, __APP_VERSION__) > 0) {
          setPendingUpdate({ tag: r.tag });
        }
      } catch {
        /* network blip — no banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function runUpgrade() {
    if (upgrading) return;
    setUpgrading(true);
    void fm.upgrade();
  }

  function next() {
    if (isLast) exit();
    else setI((n) => Math.min(SLIDES.length - 1, n + 1));
  }
  function prev() {
    setI((n) => Math.max(0, n - 1));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const slide = SLIDES[i];

  return (
    <div className="overlay help-overlay" data-state={state} onClick={exit}>
      <div
        className="help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="help__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>

        {pendingUpdate && (
          <div className="help__update" role="status">
            <span className="help__update-icon" aria-hidden>↑</span>
            <span className="help__update-text">
              Update <b>{pendingUpdate.tag}</b> available
            </span>
            <button
              type="button"
              className="help__update-btn"
              onClick={runUpgrade}
              disabled={upgrading}
            >
              {upgrading ? 'Upgrading…' : 'Update now'}
            </button>
          </div>
        )}

        <div className="help__eyebrow">
          Help · {slide.section} · {i + 1} of {SLIDES.length}
        </div>

        <div className="help__glyph" aria-hidden>
          {slide.glyph}
        </div>
        <h1 id="help-title" className="help__title">
          {slide.title}
        </h1>

        {slide.kind === 'narrative' ? (
          <p className="help__body">{slide.body}</p>
        ) : (
          <>
            <p className="help__lede">{slide.lede}</p>
            <ul className="help__verbs">
              {slide.verbs.map((v) => (
                <li key={v.name + (v.chord ?? '')} className="help__verb">
                  <span className="help__verb-name">{v.name}</span>
                  {v.chord && (
                    <kbd className="help__verb-chord">{fmtKeys(v.chord, isMac)}</kbd>
                  )}
                  <span className="help__verb-what">{fmtKeys(v.what, isMac)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="help__dots" role="tablist" aria-label="Slide">
          {SLIDES.map((_, idx) => (
            <button
              key={idx}
              type="button"
              role="tab"
              aria-selected={idx === i}
              aria-label={`Slide ${idx + 1}`}
              className={'help__dot' + (idx === i ? ' help__dot--on' : '')}
              onClick={() => setI(idx)}
            />
          ))}
        </div>

        <div className="help__footer">
          <button
            type="button"
            className="help__btn help__btn--ghost"
            onClick={prev}
            disabled={i === 0}
          >
            ← Back
          </button>
          <button
            type="button"
            className="help__btn"
            onClick={next}
            autoFocus
          >
            {isLast ? 'Done' : 'Next →'}
            <kbd className="help__btn-kbd">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
