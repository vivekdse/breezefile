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
      { name: 'tasks', what: 'open the singleton Tasks tab — split layout (list + detail panel), group by folder/status/due, search, filter, checkbox + arrow-key selection, all bulk actions via verbs' },
      { name: 'tasks-tab verbs', what: 'chip prompt swaps in: :done :reopen :in-progress :cancel · :pin :unpin · :due / :start (Today / Tomorrow / Friday / Next week / Pick…) · :open task tab · :terminal · :claude / :codex / :gemini · :edit · :goto-folder · :delete · :group :sort :filter · :show-completed · :select all/none/invert/overdue/pinned' },
      { name: 'tasks-tab keys', what: '↑/↓ move cursor · Shift+↑/↓ extend selection · Space toggle select · Enter edit · / focus search · [ / ] snooze due ∓1 day · w snooze due +7 days' },
      { name: 'row buttons', what: 'hover or land the cursor on a row to reveal: ✓ mark done (or ↺ reopen) · ✎ edit · ↗ open in task tab · ⋮ more (status, due presets, pin, go to folder, delete) · status pill is clickable to cycle pending → in_progress → done → cancelled' },
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
      { name: 'sidebar indicators', what: 'Active Tasks sidebar shows per-task glyphs: due-now dot, running spinner, last-run-failed dot, ⚡ for auto · right-click for Edit / Mark done / Pin / Snooze / Run now / View run history / Open last run in new tab / Delete' },
      { name: 'run history', what: 'every auto run lands in a per-task history dialog: status, duration, attempt, conversation_id · Rerun button starts a fresh run · "Open run" spawns a new tab with an embedded terminal and auto-runs `claude --resume <id>` so you land directly in the trace' },
      { name: 'runs view', what: 'on the Tasks tab toggle from Tasks → Runs to see every recent run across every auto task in one feed · filter by status, search by title or folder, click a row to jump into that task’s history' },
      { name: 'breeze CLI', what: 'a Node `breeze` shell command talks HTTP to the running app · `breeze status`, `breeze task list / show / add / edit / done / pin / unpin / delete / open`, `breeze open <folder>`, `breeze tabs` · <id> defaults to $BREEZE_TASK_ID inside task tabs · `breeze prime` (auto-installed Claude Code hook) feeds session context on start' },
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
      { name: 'term', what: 'open an embedded terminal pane rooted at this folder · :term-close to dismiss · drop files (from Finder, web pages, or Breeze rows) onto the pane to paste their absolute paths into the running shell / Claude Code prompt · theme-aware ANSI palette with a minimum contrast floor so colors stay readable on every theme' },
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
                  {v.chord && <kbd className="help__verb-chord">{v.chord}</kbd>}
                  <span className="help__verb-what">{v.what}</span>
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
