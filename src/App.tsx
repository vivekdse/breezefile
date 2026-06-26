import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { OverlayCtx, type OverlayApi, type RenameMode } from './overlays';
import { Titlebar } from './components/Titlebar';
import { Pathbar } from './components/Pathbar';
import { FolderList } from './components/FolderList';
import { FolderHeader } from './components/FolderHeader';
import { FilterChip } from './components/FilterChip';
import { Preview } from './components/Preview';
import { TagInspector } from './components/TagInspector';
import { DslTagOverlay } from './components/DslTagOverlay';
import { TagPicker } from './components/TagPicker';
import { Sidebar } from './components/Sidebar';
import { Statusbar } from './components/Statusbar';
import { Tabbar } from './components/Tabbar';
import { ModeLine } from './components/ModeLine';
import { Settings } from './components/Settings';
import { ChipPrompt } from './components/ChipPrompt';
import { CommandPalette } from './components/CommandPalette';
import { PasteChip } from './components/PasteChip';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { ThemePicker } from './components/ThemePicker';
import { Welcome, shouldShowWelcome } from './components/Welcome';
import { UpdateChip } from './components/UpdateChip';
import { PrivacyHelpDialog } from './components/PrivacyHelpDialog';
import { OpenWithDialog } from './components/OpenWithDialog';
import { TaskComposer, type TaskComposerRequest } from './components/TaskComposer';
import { RunHistoryDialog } from './components/RunHistoryDialog';
import { TaskDetailDrawer } from './components/tasks/TaskDetailDrawer';
import { RunTaskModal } from './components/RunTaskModal';
import { RunProgressBanner } from './components/RunProgressBanner';
import { TasksPage } from './components/TasksPage';
import { ProjectsPage } from './components/projects/ProjectsPage';
import { TaskShell } from './components/TaskShell';
import { EditSplit } from './components/EditShell';
import { BrowserPane, reapBrowserViews } from './components/BrowserPane'; // SPIKE (spike/playwright-cdp)
import { ChatPanel } from './components/ChatPanel';
import { openChatPanel, resolveAgent, isClaudeAgent, type ChatTarget } from './openChat';
import {
  ChatLaunchOptions,
  claudeChatOptions,
  type ChatLaunchOption,
} from './components/ChatLaunchOptions';
import { handleTagControl, isTagControl, type TagControlReq } from './tagControl';
import { Tutorial } from './components/Tutorial';
import { HelpTour, type HelpSlideId } from './components/HelpTour';
import { SecretsPanel } from './components/SecretsPanel';
import { TerminalSplit } from './components/TerminalSplit';
import { TypebuildSessionBanner } from './components/TypebuildSessionBanner';
import { TipsChip, isTipsEnabled, setTipsEnabled } from './components/TipsChip';
import { IconSprite } from './components/icons';
import { StoreProvider, useStore, makeTab } from './store';
import { PlatformProvider } from './platform';
import { formatOpError, humanizeError } from './errorMessages';
import { loadSideBySidePrefs, splitFraction } from './sideBySidePrefs';
import { useKeyboard } from './useKeyboard';
import { fm } from './bridge';
import { taskSourceAction } from './tasks';
import { basename, currentEntry, dirname, lastCol, pathJoin, visibleEntries } from './actions';
import { isTextEntryTarget } from './textFocus';
import { isEditablePath } from './fileTypes.ts';
import { celebratePaths } from './motion-utils';
import { useOverlayExit } from './useOverlayExit';
import type { CustomTagCriterion, Entry, Task } from './types';
import { TAG_PALETTE, assignTagKey, newTagId } from './tags';
import './App.css';


// fm-b5at.10 — map a thrown TypeBuild MCP-token mint failure to the bead's
// three exact in-app messages. Main encodes the typed code in the error
// message as "[typebuild-mint:<code>]" (IPC strips custom Error props). This
// mirrors the canonical copy in TasksPage.tsx (mintErrorMessage) for the
// relaunch path; the message text is intentionally identical so the user sees
// the same wording whether a launch or a relaunch fails. Returns a friendly
// fallback when the code isn't one of the three.
const RELAUNCH_MINT_MESSAGES: Record<string, string> = {
  'signed-out': 'Please sign in again',
  unreachable: "Can't reach TypeBuild right now",
  'access-denied': 'Your access has changed, contact your admin',
};
function relaunchErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-mint:([a-z-]+)\]/.exec(raw);
  if (m && RELAUNCH_MINT_MESSAGES[m[1]]) return RELAUNCH_MINT_MESSAGES[m[1]];
  return "Couldn't restart the session — try again";
}

// fm-dly3 — the right-docked chat panel is drag-resizable; its width persists
// across tabs and sessions. 380px matches the original fixed width / the
// --chat-w fallback in App.css. Clamp keeps it readable and leaves room for the
// file list (the OS window grows to fit via window:chatResize, but we still
// cap so a stored value can't be absurd).
const CHAT_DEFAULT_W = 380;
const CHAT_MIN_W = 280;
const CHAT_MAX_W = 1200;
const CHAT_WIDTH_KEY = 'breeze.chatPanelWidth';
const clampChatWidth = (w: number) =>
  Math.max(CHAT_MIN_W, Math.min(CHAT_MAX_W, Math.round(w)));
function readChatWidth(): number {
  try {
    const raw = localStorage.getItem(CHAT_WIDTH_KEY);
    if (raw) return clampChatWidth(parseFloat(raw));
  } catch {
    /* localStorage unavailable — fall back to default */
  }
  return CHAT_DEFAULT_W;
}

function Shell() {
  const { state, activeTab, refreshActive, dispatch, setTab, focusEntryByName, navigateTo, loadDir, openPath } = useStore();
  const [renaming, setRenaming] = useState<{ entry: Entry; mode: RenameMode } | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Optional section to expand when Settings opens via fm:openSettings
  // (e.g. the sidebar sign-in row deep-links to 'typebuild'; the chat-agent
  // prompt deep-links to 'chat-agent' when no default agent is set — fm-xt1g).
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  // fm-m7q — Cmd-K command palette over the verb registry.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState<boolean>(() => shouldShowWelcome());
  const [privacyHelpOpen, setPrivacyHelpOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialNonce, setTutorialNonce] = useState(0);
  // fm-294 — global confirm dialog. Surfaces request a confirm by
  // dispatching `fm:confirm` with a ConfirmRequest payload.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // fm-pg0 — Open With surface. The chip verb dispatches `fm:openWith`
  // with the target path; we run the native app picker here, then mount
  // OpenWithDialog so the user can confirm + optionally bind the app as
  // the default for this extension. Null when no flow is active.
  const [openWith, setOpenWith] = useState<{ path: string; ext?: string; appPath: string } | null>(
    null,
  );
  // fm-60k — Create-tag overlay. Opened via the 'newtag' verb or the
  // "+ New tag" button in the TagInspector pane.
  const [newTagOpen, setNewTagOpen] = useState(false);
  // task-317c7fe41f90 — selector-based DSL tag editor (additive; :dsltag verb).
  // fm-xr0 — null = closed; { editId } = editing an existing DSL tag;
  // { editId: null } / {} = creating a new one.
  const [dslTagOpen, setDslTagOpen] = useState<{ editId?: string | null } | null>(null);
  // fm-60k — keyboard tag HUD. Opened via `t` (apply) or `T` (filter).
  const [tagPicker, setTagPicker] = useState<'apply' | 'filter' | null>(null);
  // Slide-based help (HelpTour). Opened by the :help verb or the Help
  // link in the Statusbar. Distinct from Tutorial (interactive practice).
  const [helpOpen, setHelpOpen] = useState<{ slide?: HelpSlideId } | null>(null);
  // :secrets — the user's credential vault (NPI, Tax ID, login IDs). Server-backed.
  const [secretsOpen, setSecretsOpen] = useState(false);
  // fm-nmt — task create/edit dialog. Opened via 'task' verb, the T
  // keybind, or programmatically from the (future) sidebar/page.
  const [taskDialog, setTaskDialog] = useState<TaskComposerRequest | null>(null);
  // fm-zf3m — run history dialog (sidebar context-menu "View run history").
  const [runHistoryFor, setRunHistoryFor] = useState<string | null>(null);
  // task-5e9d866a377f — task detail DRAWER (Trace · Config · Session, Stop,
  // Enter thread). Opened via fm:openTaskDetail with the task object + an
  // optional initial tab; any task row can dispatch it.
  const [taskDetail, setTaskDetail] = useState<{
    task: Task;
    // task-b30e546672db — 'details' is the renamed/first tab; 'config' is still
    // accepted from legacy callers and mapped to 'details' inside the drawer.
    initialTab?: 'details' | 'trace' | 'config' | 'session';
  } | null>(null);
  // fm-femh — Run-task modal: pick a task to run in the active folder tab.
  const [runTaskCwd, setRunTaskCwd] = useState<string | null>(null);
  // Inline-chat launch options: when the user opens a chat we first show a
  // small picker (Continue / Skip permissions for Claude). The chosen flags
  // are threaded into openChatPanel. Holds the resolved spawn args while the
  // picker is open; null when no picker is showing.
  const [chatLaunch, setChatLaunch] = useState<{
    tabIndex: number;
    target: ChatTarget;
    agentId: string;
    agentLabel: string;
    targetLabel: string;
    options: ChatLaunchOption[];
  } | null>(null);
  // fm-kaa / fm-yi85 — Tasks overview is now a singleton tab (kind='tasks'),
  // not a modal. The :tasks verb and the sidebar "See all" link dispatch
  // openTasksTab; rendering is inline in the main slot.

  // fm-b5at.10 — TypeBuild MCP session-expiry phases, keyed by the session's
  // ptyId. Main's expiry clock pushes 'warning' (T-15min) then 'expired'
  // (at/after token lapse). The banner over the active session tab reads this;
  // 'expired' offers a one-click relaunch. `dismissed` carries ptyIds whose
  // 'warning' the user waved off (a later 'expired' for the same pty still
  // shows — that one is actionable). `relaunch` tracks the in-flight restart.
  const [expiryPhase, setExpiryPhase] = useState<
    Map<number, { phase: 'warning' | 'expired'; taskId: string }>
  >(new Map());
  const [expiryDismissed, setExpiryDismissed] = useState<Set<number>>(new Set());
  const [relaunch, setRelaunch] = useState<{ ptyId: number; error: string | null } | null>(
    null,
  );
  // fm-dly3 — persisted width of the right-docked chat panel (px). The ref lets
  // the once-mounted open/close effect read the live value without re-running.
  const [chatWidth, setChatWidth] = useState<number>(() => readChatWidth());
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;

  useKeyboard(
    (entry, mode) => setRenaming({ entry, mode }),
    () => setMkdirOpen(true),
    () => setQuickFindOpen(true),
    () => setShellOpen(true),
  );

  // fm-fux — global terminal attention monitor. Every tab's pty keeps
  // streaming data; we tap the raw IPC stream to drive the green/red tab
  // tint independent of which tab the user is viewing.
  //
  // Primary signal is the main-process foreground poller (fm-z7v,
  // term:fg): busy = shell has any descendant, idle = bare prompt.
  // term:data is kept only for BEL/OSC9 bell detection; it can't
  // drive busy/idle because fm-81n showed it goes silent under heavy
  // TUI streaming (Claude Code).
  //
  // Subscription lifecycle: we subscribe ONCE on mount and read mutable
  // state through refs. Earlier versions put `state.tabs` in the effect
  // deps, which tore down + re-subscribed on every attention dispatch —
  // and during rapid streaming that meant data events fired between
  // unsubscribe and resubscribe, getting dropped on the floor. The
  // visible symptom was "no logs during Claude streaming."
  // Live refs the once-mounted handler reads. Updating these on every
  // render keeps the closure current without triggering a re-subscribe.
  const tabsRef = useRef(state.tabs);
  const notifyOnAttentionRef = useRef(state.notifyOnAttention);
  const soundOnAttentionRef = useRef(state.soundOnAttention);
  const activeTabIdxRef = useRef(state.activeTab);
  // fm-h8g7 — live refs read by the once-mounted task-notification handlers.
  const taskNotificationsRef = useRef(state.taskNotifications);
  tabsRef.current = state.tabs;
  // Expose the open-tab count so the main process can warn before a full
  // BrowserWindow reload (Cmd/Ctrl+Shift+R) blows away every tab + pty.
  (window as unknown as { __fmTabCount?: number }).__fmTabCount =
    state.tabs.length;
  notifyOnAttentionRef.current = state.notifyOnAttention;
  soundOnAttentionRef.current = state.soundOnAttention;
  activeTabIdxRef.current = state.activeTab;
  taskNotificationsRef.current = state.taskNotifications;

  // fm-h8g7 — true when the currently-active tab is the Tasks page. The badge
  // counts unseen task events only while the user is NOT looking at Tasks.
  const tasksTabActiveRef = useRef(false);
  tasksTabActiveRef.current =
    state.tabs[state.activeTab]?.kind === 'tasks';
  // fm-9iha — live ref so the (once-subscribed) chat toggle reads the current
  // default agent without re-subscribing.
  const defaultAgentRef = useRef(state.defaultAgentId);
  defaultAgentRef.current = state.defaultAgentId;

  useEffect(() => {
    const maybeNotify = (
      idx: number,
      from: 'idle' | 'busy' | 'bell' | null,
      to: 'idle' | 'bell',
      // `urgent` bypasses the active-tab suppression. Mid-turn Claude
      // Notification hooks (permission prompts, idle warnings) set this
      // because they're easy to miss in a stream of TUI output even
      // when the user is theoretically "looking at" the tab.
      urgent = false,
    ) => {
      const wasAttention = from === 'idle' || from === 'bell';
      if (wasAttention) return;
      // For non-urgent transitions (end-of-turn Stop), suppress the
      // banner only when the user is already looking at this exact
      // tab — they don't need a notification for something on screen.
      // Urgent (mid-turn Notification) always banners.
      if (!urgent && appFocusRef.current && activeTabIdxRef.current === idx) return;
      if (!notifyOnAttentionRef.current) return;
      const tab = tabsRef.current[idx];
      if (!tab) return;
      const folder = tab.terminal?.cwd
        ? tab.terminal.cwd.split('/').filter(Boolean).pop() ?? tab.terminal.cwd
        : 'terminal';
      const launcher = tab.terminal?.label;
      const title = launcher
        ? `${launcher} in ${folder}`
        : `Terminal in ${folder}`;
      const body =
        to === 'bell'
          ? 'Alert'
          : urgent
            ? 'Needs your input'
            : 'Waiting for input';
      if (soundOnAttentionRef.current) {
        void fm.playAttentionSound();
      }
      // Route via main process so click works reliably on Linux libnotify
      // daemons and any "View" button surfaced by the daemon focuses the
      // right tab. The main-side handler emits 'app:notification-clicked'
      // with tabId; the listener below resolves that to current index.
      void fm.showAttentionNotification({ title, body, tabId: tab.id });
    };

    // Busy/idle is driven by Claude Code hooks (fm-z7v, term:fg), which
    // are authoritative. Two safety nets cover MISSED hook events
    // (fm-9iyx) — they matter more now that recent Claude Code releases
    // (2.1.69 spinner isolation, 2.1.117 idle re-render fix, …) emit far
    // fewer PTY bytes during a turn, so a working session can sit silent
    // for many seconds:
    //
    //  1. Silence watchdog — while a pty is 'busy' we arm a timer that any
    //     term:data byte resets. If no output flows for SILENCE_MS the tab
    //     is *provisionally* flipped to idle (interrupt/crash where Stop
    //     never fired). It's only a guess, so we DON'T banner — and we
    //     remember the pty in `watchdogIdle` so the flip can be undone.
    //  2. Output recovery — if a watchdog-idled pty emits ANY byte again,
    //     it was alive all along (slow tool call / long thinking), so we
    //     restore 'busy' immediately. This is why the dot no longer sticks
    //     red while Claude is quietly working.
    //
    // A coarse RECONCILE_MS poll re-checks both directions in case an
    // event was dropped entirely, so a stale dot can't wedge for longer
    // than one tick. term:data still can't *originate* busy (it goes silent
    // under heavy TUI streaming, fm-81n) — it only sustains or recovers a
    // state the hooks established. SILENCE_MS is generous (45s) because a
    // quiet-but-working turn is now common; an interrupt still resolves
    // within a tick once output stops.
    const SILENCE_MS = 45_000;
    const RECONCILE_MS = 15_000;
    const silenceTimers = new Map<number, ReturnType<typeof setTimeout>>();
    // ptys the watchdog provisionally flipped to idle — eligible for
    // output-driven recovery back to 'busy'. Any authoritative hook event
    // clears the marker.
    const watchdogIdle = new Set<number>();
    // last term:data timestamp per pty, for the reconcile poll's staleness
    // check. Cheap to maintain; only read on the tick.
    const lastDataAt = new Map<number, number>();
    const clearSilence = (ptyId: number) => {
      const t = silenceTimers.get(ptyId);
      if (t) {
        clearTimeout(t);
        silenceTimers.delete(ptyId);
      }
    };
    const armSilence = (ptyId: number) => {
      clearSilence(ptyId);
      const t = setTimeout(() => {
        silenceTimers.delete(ptyId);
        const tabs = tabsRef.current;
        const idx = tabs.findIndex((t) => t.terminal?.ptyId === ptyId);
        if (idx < 0) return;
        if (tabs[idx].terminal?.attention !== 'busy') return;
        // Provisional flip: silence only *guesses* the turn ended (it could
        // be a slow tool call). Turn the dot red but suppress the banner —
        // a guess shouldn't interrupt — and remember the pty so resumed
        // output can restore 'busy'.
        dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'idle' });
        watchdogIdle.add(ptyId);
      }, SILENCE_MS);
      silenceTimers.set(ptyId, t);
    };
    const offData = fm.onTermData((id) => {
      lastDataAt.set(id, Date.now());
      if (silenceTimers.has(id)) {
        // Already tracked as busy — sustain it (resets the watchdog).
        armSilence(id);
      } else if (watchdogIdle.has(id)) {
        // Output resumed after the watchdog gave up: the session was alive
        // all along (slow tool call / long thinking). Restore busy.
        watchdogIdle.delete(id);
        const tabs = tabsRef.current;
        const idx = tabs.findIndex((t) => t.terminal?.ptyId === id);
        if (idx >= 0 && tabs[idx].terminal?.attention === 'idle') {
          dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'busy' });
          armSilence(id);
        }
      }
    });

    const offFg = fm.onTermFg((id, busy, _comm, state) => {
      const tabs = tabsRef.current;
      const idx = tabs.findIndex((t) => t.terminal?.ptyId === id);
      if (idx < 0) return;
      // An authoritative hook event supersedes the watchdog's guess: clear
      // the recovery marker so a real Stop can't be undone by stray output.
      watchdogIdle.delete(id);
      const cur = tabs[idx].terminal?.attention ?? null;
      // Tri-state from the hook bridge. Older hook scripts that only
      // know 'busy'/'idle' keep working via the legacy `busy` bool.
      const effective: 'busy' | 'idle' | 'waiting' =
        state ?? (busy ? 'busy' : 'idle');
      if (effective === 'busy' && cur !== 'busy') {
        dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'busy' });
        armSilence(id);
      } else if (effective === 'waiting') {
        // Mid-turn permission prompt. Force a transition even when the
        // tab was already showing 'idle' (rare race) so the banner
        // fires. We pass `urgent` so maybeNotify ignores active-tab
        // suppression — these are the most miss-able events.
        if (cur !== 'idle') {
          dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'idle' });
        }
        // Bypass the wasAttention guard by treating prior state as
        // null/busy when it was already idle — otherwise repeated
        // permission prompts in one turn (which we want to surface)
        // would be eaten.
        const fromForNotify: 'idle' | 'busy' | 'bell' | null =
          cur === 'idle' ? 'busy' : cur;
        maybeNotify(idx, fromForNotify, 'idle', true);
      } else if (effective === 'idle' && cur !== 'idle') {
        dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'idle' });
        clearSilence(id);
        maybeNotify(idx, cur, 'idle');
      }
    });
    // fm-9iyx — coarse safety-net poll. The event handlers above react
    // instantly; this only catches the rare case where a term:data or
    // term:fg event was dropped entirely, so a stale dot can't wedge for
    // more than one tick. A handful of map lookups every 15s.
    const reconcile = setInterval(() => {
      const now = Date.now();
      const tabs = tabsRef.current;
      for (let idx = 0; idx < tabs.length; idx++) {
        const term = tabs[idx].terminal;
        if (!term) continue;
        const id = term.ptyId;
        const att = term.attention ?? null;
        const last = lastDataAt.get(id);
        if (att === 'busy' && !silenceTimers.has(id)) {
          // Busy but no live watchdog (a term:fg/data event was dropped).
          // Flip now if already stale, else re-arm so the silence path
          // resumes governing it.
          if (last && now - last > SILENCE_MS) {
            dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'idle' });
            watchdogIdle.add(id);
          } else {
            armSilence(id);
          }
        } else if (
          att === 'idle' &&
          watchdogIdle.has(id) &&
          last &&
          now - last < RECONCILE_MS
        ) {
          // Watchdog-idled but produced output within the last tick — a
          // recovery term:data event must have been dropped. Restore busy.
          watchdogIdle.delete(id);
          dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: 'busy' });
          armSilence(id);
        }
      }
    }, RECONCILE_MS);

    return () => {
      offFg();
      offData();
      clearInterval(reconcile);
      for (const t of silenceTimers.values()) clearTimeout(t);
      silenceTimers.clear();
      watchdogIdle.clear();
      lastDataAt.clear();
    };
    // Subscribe ONCE on mount. State is read through refs so the handler
    // sees current values without triggering re-subscription. Earlier
    // versions re-subscribed on every dispatch and dropped the events
    // that fired between unsubscribe and resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fm-c2w — track window focus from main. Used to gate notifications
  // (we only raise them when backgrounded) and to decide whether the
  // dock badge has any reason to exist while focused.
  const [appFocused, setAppFocused] = useState(true);
  const appFocusRef = useRef(true);
  useEffect(() => {
    appFocusRef.current = appFocused;
  }, [appFocused]);
  useEffect(() => {
    const off = fm.onAppFocus((f) => setAppFocused(f));
    return off;
  }, []);

  // Main process emits this when the user clicks an attention notification.
  // Resolve tabId → current index here (tab order may have changed since
  // the notification was shown) and focus that tab.
  useEffect(() => {
    const off = fm.onNotificationClicked((tabId) => {
      const idx = tabsRef.current.findIndex((t) => t.id === tabId);
      if (idx >= 0) dispatch({ type: 'selectTab', index: idx });
    });
    return off;
  }, []);

  // fm-h8g7 — task-notification surfaces. Three event feeds drive the sidebar
  // badge + (for transitions) an in-app statusbar toast:
  //   task-runs:succeeded / task-runs:failed → bump badge (count only)
  //   tasks:transitions (PHI-free) → bump badge + toast
  // We bump the badge ONLY when the Tasks page isn't the active tab (a user
  // looking at Tasks already sees the change). The OS-notification gate lives
  // in main; the in-app toast gates on the renderer's own verbosity copy.
  useEffect(() => {
    const bumpIfHidden = (by = 1) => {
      if (!tasksTabActiveRef.current) dispatch({ type: 'bumpTasksBadge', by });
    };
    const offSucceeded = fm.onTaskRunSucceeded(() => bumpIfHidden());
    const offFailed = fm.onTaskRunFailed(() => bumpIfHidden());
    const offTransitions = fm.onTaskTransitions((transitions) => {
      if (!transitions || transitions.length === 0) return;
      bumpIfHidden(transitions.length);
      // In-app statusbar toast so a focused user sees the change without OS
      // noise. Gate on the renderer's verbosity copy (transitions = 'all').
      // PHI-free: only the opaque short id + kind.
      if (taskNotificationsRef.current !== 'all') return;
      const labelFor = (k: string) =>
        k === 'completed'
          ? 'completed'
          : k === 'partial'
            ? 'partially completed'
            : k === 'cancelled'
              ? 'cancelled'
              : k === 'blocked'
                ? 'blocked'
                : k === 'claim-lost'
                  ? 'claim released'
                  : 'available';
      const msg =
        transitions.length > 3
          ? `${transitions.length} TypeBuild tasks changed`
          : transitions
              .map(
                (t) =>
                  `${t.source === 'typebuild' ? 'TypeBuild' : t.source} task ${t.taskId.slice(0, 8)} ${labelFor(t.kind)}`,
              )
              .join('; ');
      dispatch({ type: 'setStatus', msg });
    });
    return () => {
      offSucceeded();
      offFailed();
      offTransitions();
    };
  }, []);

  // fm-h8g7 — main process emits this when the user clicks ANY task
  // notification. Open/focus the Tasks page and, if a taskId is present,
  // focus that row via the existing fm:tasks:focus mechanism.
  useEffect(() => {
    const off = fm.onTasksNotificationClicked(({ taskId }) => {
      dispatch({ type: 'openTasksTab' });
      if (taskId) {
        window.dispatchEvent(
          new CustomEvent('fm:tasks:focus', { detail: { taskId } }),
        );
      }
    });
    return off;
  }, []);

  // fm-h8g7 — clear the unseen-task badge once the user is looking at the
  // Tasks page (opened or activated).
  useEffect(() => {
    if (state.tabs[state.activeTab]?.kind === 'tasks') {
      dispatch({ type: 'clearTasksBadge' });
    }
  }, [state.activeTab, state.tabs]);

  // Native menu items forward a verb id here. Open ChipPrompt pre-loaded
  // with that verb — zero-slot verbs auto-execute, multi-slot verbs land
  // on the first option list so the user picks. Mirrors the keyboard
  // path that types ':<verb>'.
  useEffect(() => {
    const off = fm.onMenuVerb((verbId) => {
      dispatch({ type: 'setMode', mode: 'command', verb: verbId });
    });
    return off;
  }, [dispatch]);

  // fm-dly3 — toggle the agent chat panel for the active tab. Centralized
  // here (rather than in the verb / header icons) so the folder-vs-document
  // target and the open/close decision live in one place; the chip verb and
  // the header chat icons just fire `fm:toggle-chat`. Subscribes once and
  // reads live state through refs.
  useEffect(() => {
    const onToggle = () => {
      const idx = activeTabIdxRef.current;
      const t = tabsRef.current[idx];
      if (!t) return;
      if (t.chat) {
        void fm.termKill(t.chat.ptyId).catch(() => {});
        dispatch({ type: 'closeChat', tabIndex: idx });
        return;
      }
      // fm-xt1g — no per-chat picker; the Settings default is authoritative.
      // If it's unset, surface it (jump to the Chat agent setting) instead of
      // silently guessing an agent.
      const surfaceDefault = (msg: string) => {
        dispatch({ type: 'setStatus', msg });
        setSettingsSection('chat-agent');
        setSettingsOpen(true);
      };
      if (!defaultAgentRef.current) {
        surfaceDefault('Pick a default chat agent in Settings to start chatting');
        return;
      }
      const target: ChatTarget =
        t.kind === 'edit' && t.editPath
          ? { kind: 'document', filePath: t.editPath }
          : { kind: 'folder', cwd: t.trail[lastCol(t)] };
      // Resolve the agent up front so the picker can offer agent-specific
      // launch flags (Claude's --continue / skip-permissions) and degrade to a
      // bare confirm for everything else. If the default agent no longer
      // resolves, surface the Settings prompt — same as openChatPanel's
      // needsAgent path — instead of guessing.
      const agentId = defaultAgentRef.current!;
      void resolveAgent(agentId).then((agent) => {
        if (!agent) {
          surfaceDefault('Your default chat agent is unavailable — pick another');
          return;
        }
        const targetLabel =
          target.kind === 'document' ? target.filePath : target.cwd;
        setChatLaunch({
          tabIndex: idx,
          target,
          agentId,
          agentLabel: agent.label,
          targetLabel,
          options: isClaudeAgent(agent) ? claudeChatOptions() : [],
        });
      });
    };
    window.addEventListener('fm:toggle-chat', onToggle);
    return () => window.removeEventListener('fm:toggle-chat', onToggle);
  }, [dispatch]);

  // fm-dly3 — widen the OS window while the active tab shows a chat panel so
  // the editor / file list keeps its width. Restores when the chat closes or
  // you switch to a chat-less tab. Reads the live panel width via ref so it
  // grows the window to the user's resized width on open, without re-running
  // on every drag (the drag handler below re-grows the window directly).
  const chatVisible = !!state.tabs[state.activeTab]?.chat;
  useEffect(() => {
    void fm.windowChatResize(chatVisible, chatWidthRef.current);
  }, [chatVisible]);

  // fm-dly3 — live drag-resize of the chat panel. ChatPanel's left-edge gutter
  // reports horizontal pointer deltas (dragging left ⇒ wider). We update the
  // persisted width and re-grow the OS window so the file list keeps its size;
  // window:chatResize caps at the screen edge, past which CSS lets the file
  // area yield. Coalesced to one window-grow per frame.
  const chatResizeRaf = useRef<number | null>(null);
  const onChatResizeDelta = (dx: number) => {
    const next = clampChatWidth(chatWidthRef.current - dx);
    if (next === chatWidthRef.current) return;
    chatWidthRef.current = next;
    setChatWidth(next);
    if (chatResizeRaf.current == null) {
      chatResizeRaf.current = requestAnimationFrame(() => {
        chatResizeRaf.current = null;
        void fm.windowChatResize(true, chatWidthRef.current);
      });
    }
  };
  const onChatResizeEnd = () => {
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidthRef.current));
    } catch {
      /* localStorage unavailable — width still applies for this session */
    }
  };

  // fm-c2w — dock badge reflects how many tabs currently demand
  // attention (idle waiting-for-input or explicit bell). 'busy' is
  // generating-only and doesn't count — we don't want a badge while
  // Claude is just thinking. The active tab is excluded: even if its
  // terminal is idle, the user's eyes are already on it, so no need
  // to badge the dock.
  const attentionCount = state.tabs.filter(
    (t, i) =>
      i !== state.activeTab &&
      (t.terminal?.attention === 'idle' || t.terminal?.attention === 'bell'),
  ).length;
  useEffect(() => {
    const text = attentionCount === 0 ? '' : String(attentionCount);
    void fm.setDockBadge(text);
  }, [attentionCount]);

  // Bell is a one-shot "I just pinged you" alert — once you've looked at
  // the tab, the bell has done its job and should clear. Idle/busy tints
  // track the live terminal state (cursor visibility) and stay accurate
  // regardless of which tab is active, so we DON'T clear those here.
  useEffect(() => {
    const t = state.tabs[state.activeTab];
    if (t?.terminal?.attention === 'bell') {
      dispatch({
        type: 'setTerminalAttention',
        tabIndex: state.activeTab,
        attention: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTab]);

  // fm-9fd — control bridge from the HTTP API server. Main delegates
  // app-level commands (navigate, openTaskTab, launch, listTabs) here
  // because state.tabs lives in the renderer. Each request carries a
  // reqId; we resolve it by sending control:reply.
  useEffect(() => {
    const off = fm.onControlRequest(async (req) => {
      try {
        let result: unknown = { ok: true };
        switch (req.kind) {
          case 'navigate': {
            const p = req.path as string;
            if (typeof p !== 'string' || !p) throw new Error('path required');
            // navigate the active tab via the existing helper
            await Promise.resolve();
            window.dispatchEvent(
              new CustomEvent('fm:apiNavigate', { detail: { path: p } }),
            );
            break;
          }
          case 'open': {
            // `breeze open <path>` — classify the path and route it to the
            // right surface. Folders open as a tab; markdown opens in the
            // in-app editor; everything else defers to the OS default app
            // (mirrors the Enter/goRight behaviour in useKeyboard.ts).
            const p = req.path as string;
            if (typeof p !== 'string' || !p) throw new Error('path required');
            let st: { isDir: boolean };
            try {
              st = await fm.stat(p);
            } catch {
              throw new Error(`cannot open: no such file or folder: ${p}`);
            }
            if (st.isDir) {
              dispatch({ type: 'openOrFocusFolderTab', path: p, focus: true });
              result = { ok: true, kind: 'folder' };
            } else {
              if (isEditablePath(p)) {
                dispatch({ type: 'openEditTab', path: p, focus: true });
                result = { ok: true, kind: 'edit' };
              } else {
                // Fire-and-forget, like goRight in useKeyboard.ts: the OS
                // open can block (Linux xdg-open) far past the control
                // timeout, so don't await it or the CLI reports a spurious
                // failure for a launch that actually succeeded.
                dispatch({ type: 'pushRecentFile', path: p });
                void fm.open(p);
                result = { ok: true, kind: 'external' };
              }
            }
            break;
          }
          case 'openTaskTab': {
            const taskId = req.taskId as string;
            if (!taskId) throw new Error('taskId required');
            const t = await fm.tasksGet(taskId);
            if (!t) throw new Error('task not found');
            dispatch({ type: 'openTaskTab', taskId, folder: t.folder });
            break;
          }
          case 'launch': {
            // Defer to the same code path as TaskShell launcher buttons via
            // a window event the shell listens for. Out of scope for v1
            // initial commit — return 'not implemented' so the CLI surfaces
            // a clear error rather than hanging.
            throw new Error('launch via API not implemented in v1');
          }
          // SPIKE (spike/playwright-cdp) — open an embedded browser tab on
          // demand (api-server /app/open-browser). Lets an in-app agent create
          // the tab it drives over CDP without a keypress.
          case 'openBrowser': {
            const url = (req.url as string) || 'https://example.com';
            // Reuse + focus an existing browser tab rather than spawning a
            // second view (the agent may call `open` more than once).
            const existing = tabsRef.current.findIndex((t) => t.kind === 'browser');
            if (existing >= 0) {
              dispatch({ type: 'selectTab', index: existing });
            } else {
              dispatch({
                type: 'newTab',
                tab: makeTab('/', { kind: 'browser', browserUrl: url }),
              });
            }
            break;
          }
          case 'listTabs': {
            result = state.tabs.map((t) => ({
              id: t.id,
              kind: t.kind,
              taskId: t.taskId ?? null,
              cwd: t.trail[t.trail.length - 1] ?? '',
              terminal: t.terminal ? { ptyId: t.terminal.ptyId } : null,
            }));
            break;
          }
          default:
            // fm-awii — agent tagging API. Tags live in this store, so the
            // HTTP API proxies tag ops here.
            if (isTagControl(req.kind)) {
              result = handleTagControl(req as unknown as TagControlReq, {
                customTags: state.customTags,
                tagPaths: state.tagPaths,
                dispatch,
                now: Date.now(),
              });
              break;
            }
            throw new Error(`unknown control kind: ${req.kind}`);
        }
        fm.sendControlReply({ reqId: req.reqId, ok: true, result });
      } catch (err) {
        fm.sendControlReply({
          reqId: req.reqId,
          ok: false,
          error: (err as Error).message,
        });
      }
    });
    return off;
  }, [dispatch, state.tabs, state.customTags, state.tagPaths]);

  // Bridge fm:apiNavigate → store.navigateTo so the API navigate command
  // routes through the same code path as user-driven nav (history, marks,
  // entries cache). This indirection avoids capturing navigateTo in the
  // control listener's deps and re-subscribing on every navigation.
  useEffect(() => {
    function onApiNav(e: Event) {
      const p = (e as CustomEvent).detail?.path as string | undefined;
      if (p) void navigateTo(p);
    }
    window.addEventListener('fm:apiNavigate', onApiNav);
    return () => window.removeEventListener('fm:apiNavigate', onApiNav);
  }, [navigateTo]);

  // fm-b5at.7 — interactive task run. Main has already spawned the claude
  // PTY (into the shared term registry) and tells us the ptyId; we open a
  // new tab and attach the existing terminal so the user lands in the live
  // session. The fg-state attention tint then works for free (the pty is a
  // normal managed terminal). We attach, not spawn — main owns the pty.
  useEffect(() => {
    const off = fm.onTasksInteractiveRun((payload) => {
      // Captured BEFORE we open/focus the new tab: if the user kicked this off
      // from the Tasks tab, the session tab returns there on exit.
      const fromTasksTab = tasksTabActiveRef.current;
      const newTabIndex = tabsRef.current.length;
      dispatch({ type: 'newTab', tab: makeTab(payload.cwd) });
      dispatch({
        type: 'openTerminal',
        tabIndex: newTabIndex,
        ptyId: payload.ptyId,
        cwd: payload.cwd,
        // PHI: for phiSensitive sources (TypeBuild) `title` is already the
        // generic, content-free label main built; never the decrypted title.
        label: payload.title,
        source: payload.source,
        // fm-7909 — session-per-task: carry the task id so the Tasks page can
        // map taskId → this open session tab (Open session, not a 2nd Start).
        taskId: payload.taskId,
        returnToTasksOnExit: fromTasksTab,
      });
      dispatch({
        type: 'setStatus',
        msg: `interactive run · ${payload.title}`,
      });

      // fm-b5at.6 — auto side-by-side for TypeBuild sessions. When the user
      // setting is on, snap our window to the right and Chrome to the left so
      // they watch Claude drive the browser while approving here. Own-window
      // arrangement always works; Chrome moves opportunistically (degraded
      // parity on Wayland / missing Accessibility — no error surfaced here).
      if (payload.source === 'typebuild') {
        const prefs = loadSideBySidePrefs();
        if (prefs.autoOnTaskStart) {
          void fm.sideBySide.enter(splitFraction(prefs)).catch(() => {
            /* best-effort; degraded mode leaves windows as-is */
          });
        }
      }
    });
    return off;
  }, [dispatch]);

  // fm-b5at.6 — auto-exit side-by-side when the last TypeBuild terminal tab
  // closes. We track the count of open typebuild terminal tabs; on the
  // >0 → 0 transition we restore the window's previous bounds. Manual toggle
  // (:sidebyside) is independent — it flips state on the main side and this
  // effect only acts on the closing edge, so it won't fight the user.
  const prevTbTermCount = useRef(0);
  useEffect(() => {
    const count = state.tabs.filter(
      (t) => t.terminal?.source === 'typebuild',
    ).length;
    if (prevTbTermCount.current > 0 && count === 0) {
      void fm.sideBySide.state().then((s) => {
        if (s.active) void fm.sideBySide.exit().catch(() => {});
      });
    }
    prevTbTermCount.current = count;
  }, [state.tabs]);

  // fm-b5at.5 — a TypeBuild session's PTY exited while the user still holds
  // the claim. Offer a gentle Release. PHI-free: only the task id crosses the
  // wire; no title/body. Routes through the global confirm dialog.
  useEffect(() => {
    const off = fm.onTypebuildReleasePrompt(({ taskId }) => {
      const req: ConfirmRequest = {
        title: 'Release this TypeBuild task?',
        body: 'The session ended but you still hold the claim. Release it so others can pick it up, or keep it to resume.',
        confirmLabel: 'Release',
        cancelLabel: 'Keep',
        onConfirm: async () => {
          try {
            await taskSourceAction('typebuild', taskId, 'release');
            dispatch({ type: 'setStatus', msg: 'released TypeBuild task' });
          } catch {
            dispatch({ type: 'setStatus', msg: 'could not release task' });
          }
        },
      };
      window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
    });
    return off;
  }, [dispatch]);

  // fm-b5at.10 — TypeBuild MCP session-expiry phases. Main's expiry clock
  // broadcasts 'warning' (T-15min) and 'expired' (at/after token lapse) per
  // live session, keyed by ptyId. We stash the phase so the banner over the
  // active session tab can render it. We never surface the raw MCP error — the
  // banner sits over it with a friendly relaunch.
  useEffect(() => {
    const off = fm.onTypebuildSessionExpiry(({ ptyId, taskId, phase }) => {
      setExpiryPhase((prev) => {
        const next = new Map(prev);
        next.set(ptyId, { phase, taskId });
        return next;
      });
      // A fresh 'expired' supersedes a dismissed 'warning' for the same pty —
      // that one is actionable, so clear the dismiss so the banner shows.
      if (phase === 'expired') {
        setExpiryDismissed((prev) => {
          if (!prev.has(ptyId)) return prev;
          const next = new Set(prev);
          next.delete(ptyId);
          return next;
        });
      }
    });
    return off;
  }, []);

  // fm-b5at.10 — when a session's PTY exits (user closed the tab / Ctrl-D /
  // the relaunch killed the old pty), prune its expiry bookkeeping so a stale
  // banner never lingers. The relaunch path also clears the OLD pty below;
  // this is the catch-all for normal exits.
  useEffect(() => {
    const off = fm.onTermExit((id) => {
      setExpiryPhase((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setExpiryDismissed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setRelaunch((r) => (r?.ptyId === id ? null : r));
    });
    return off;
  }, []);

  // fm-b5at.10 — after a successful relaunch, main repoints the tab onto the
  // new pty. Swap the terminal in place (no tab churn), then clear all expiry
  // bookkeeping for the OLD pty (the new one starts with a fresh ~8h horizon;
  // the clock re-arms server-side).
  useEffect(() => {
    const off = fm.onTypebuildSessionRelaunched(
      ({ oldPtyId, newPtyId, cwd, title }) => {
        dispatch({
          type: 'repointTerminal',
          oldPtyId,
          newPtyId,
          cwd,
          label: title,
        });
        setExpiryPhase((prev) => {
          if (!prev.has(oldPtyId)) return prev;
          const next = new Map(prev);
          next.delete(oldPtyId);
          return next;
        });
        setExpiryDismissed((prev) => {
          if (!prev.has(oldPtyId)) return prev;
          const next = new Set(prev);
          next.delete(oldPtyId);
          return next;
        });
        setRelaunch((r) => (r?.ptyId === oldPtyId ? null : r));
      },
    );
    return off;
  }, [dispatch]);

  // Self-heal the permissionsPrimed flag on every launch so the Welcome
  // notice only appears when something is actually needed. primePermissions
  // is silent for already-granted folders (opendir succeeds without
  // re-prompting), so this is a no-op when the OS already has all grants.
  // If localStorage was wiped between launches but TCC still has them,
  // we restore the flag without ever showing the notice. Truly first-time
  // users (no grants yet) hit the existing Welcome flow as before, since
  // primePermissions returns 'denied' or pending and the flag stays unset.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('fm.permissionsPrimed') === '1') return;
    void fm.primePermissions().then((res) => {
      const needsAction = Object.values(res).some(
        (s) => s !== 'granted' && s !== 'missing',
      );
      if (!needsAction) {
        try { localStorage.setItem('fm.permissionsPrimed', '1'); } catch { /* noop */ }
      }
    }).catch(() => { /* noop */ });
  }, []);

  useEffect(() => {
    function h(e: KeyboardEvent) {
      // Don't hijack `?` while the user is typing — any text field (search,
      // rename, the new-task form), or a contenteditable surface like the
      // Milkdown markdown editor. Also bail while the task composer owns the
      // keyboard, so `?` is inert even on its non-field elements.
      if (isTextEntryTarget(e) || document.body.dataset.composerOpen === 'true')
        return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
      // SPIKE (spike/playwright-cdp) — Cmd/Ctrl+B opens an embedded browser tab.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        dispatch({
          type: 'newTab',
          tab: makeTab('/', {
            kind: 'browser',
            browserUrl: 'https://example.com',
          }),
        });
      }
    }
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // SPIKE (spike/playwright-cdp) — main process asks us to open a browser tab
  // (the `playwright` task flag opens one for the agent to drive over CDP).
  useEffect(() => {
    return fm.onBrowserOpen(({ url }) => {
      // Reuse + focus an existing browser tab rather than spawning a second
      // view (the playwright flag and the agent's `open` can both fire).
      const existing = tabsRef.current.findIndex((t) => t.kind === 'browser');
      if (existing >= 0) {
        dispatch({ type: 'selectTab', index: existing });
        return;
      }
      dispatch({
        type: 'newTab',
        tab: makeTab('/', {
          kind: 'browser',
          browserUrl: url || 'https://example.com',
        }),
      });
    });
  }, []);

  // SPIKE (spike/playwright-cdp) — browser views persist across tab switches
  // (BrowserPane hides instead of destroying). When a browser tab is actually
  // closed it stops appearing here, so reap its now-orphaned native view.
  useEffect(() => {
    const live = new Set(
      state.tabs.filter((t) => t.kind === 'browser').map((t) => t.id),
    );
    reapBrowserViews(live);
  }, [state.tabs]);

  // Bridge events from ChipPrompt → the overlays owned by App
  useEffect(() => {
    function onRename(e: Event) {
      const path = (e as CustomEvent).detail?.path as string | undefined;
      if (!path || !activeTab) return;
      const cwd = activeTab.trail[activeTab.trail.length - 1];
      const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
      const entry = entries.find((ent) => ent.path === path);
      if (entry) setRenaming({ entry, mode: 'full' });
    }
    function onMkdir() {
      setMkdirOpen(true);
    }
    function onTouch() {
      setTouchOpen(true);
    }
    function onTheme() {
      setThemeOpen(true);
    }
    function onCommandPalette() {
      setPaletteOpen(true);
    }
    function onPrivacyHelp() {
      setPrivacyHelpOpen(true);
    }
    function onTutorial() {
      // Always start from step 1 when explicitly opened — picking it up
      // mid-flow on a new launch is fine, but a re-launch via the verb
      // means the user wants to take it again.
      try {
        localStorage.removeItem('fm.tutorial.step');
        localStorage.removeItem('fm.tutorial.done');
      } catch {
        /* noop */
      }
      setTutorialOpen(true);
      setTutorialNonce((n) => n + 1);
    }
    function onToggleTips() {
      const next = !isTipsEnabled();
      setTipsEnabled(next);
      dispatch({
        type: 'setStatus',
        msg: next ? 'tips on' : 'tips off — type tips to bring them back',
      });
    }
    function onConfirm(e: Event) {
      const detail = (e as CustomEvent).detail as ConfirmRequest | undefined;
      if (detail) setConfirm(detail);
    }
    function onNewTag() {
      setNewTagOpen(true);
    }
    function onNewDslTag() {
      setDslTagOpen({});
    }
    // fm-xr0 — open the DSL-tag editor on an existing tag (frozen toggle etc.).
    function onEditDslTag(e: Event) {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (id) setDslTagOpen({ editId: id });
    }
    // fm-mp1 — open a tagDsl selector as a live filter-tab (smart folder).
    function onOpenFilterTab(e: Event) {
      const selector = (e as CustomEvent).detail?.selector as string | undefined;
      const scope = (e as CustomEvent).detail?.scope as string | undefined;
      if (!selector || !selector.trim()) return;
      dispatch({ type: 'openFilterTab', selector: selector.trim(), scope });
    }
    function onTagPicker(e: Event) {
      const detail = (e as CustomEvent).detail as { mode: 'apply' | 'filter' } | undefined;
      setTagPicker(detail?.mode ?? 'apply');
    }
    function onHelp(e: Event) {
      const detail = (e as CustomEvent).detail as { slide?: HelpSlideId } | undefined;
      setHelpOpen({ slide: detail?.slide });
    }
    function onWelcome() {
      setWelcomeOpen(true);
    }
    function onSecrets() {
      setSecretsOpen(true);
    }
    function onOpenTask(e: Event) {
      const detail = (e as CustomEvent).detail as TaskComposerRequest | undefined;
      if (detail) setTaskDialog(detail);
    }
    function onOpenRunHistory(e: Event) {
      const detail = (e as CustomEvent).detail as { taskId?: string } | undefined;
      if (detail?.taskId) setRunHistoryFor(detail.taskId);
    }
    function onOpenTaskDetail(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { task?: Task; initialTab?: 'trace' | 'config' | 'session' }
        | undefined;
      if (detail?.task) setTaskDetail({ task: detail.task, initialTab: detail.initialTab });
    }
    function onOpenRunTask(e: Event) {
      const detail = (e as CustomEvent).detail as { cwd?: string } | undefined;
      if (detail?.cwd) setRunTaskCwd(detail.cwd);
    }
    function onReloadDir(e: Event) {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      if (detail?.path) void loadDir(detail.path);
    }
    function onSetStatus(e: Event) {
      const detail = (e as CustomEvent).detail as { msg?: string } | undefined;
      if (detail?.msg) dispatch({ type: 'setStatus', msg: detail.msg });
    }
    function onOpenTasksPage(e: Event) {
      // fm-39969baf — optional folder filter deep-link. Stash it on window so
      // a freshly-mounted TasksPage can pick it up as its initial filter, and
      // also re-broadcast so an already-mounted page applies it immediately.
      const folder = (e as CustomEvent).detail?.folder as string | undefined;
      const w = window as unknown as { __fmTasksFolderFilter?: string };
      if (folder !== undefined) w.__fmTasksFolderFilter = folder;
      dispatch({ type: 'openTasksTab' });
      if (folder !== undefined) {
        window.dispatchEvent(
          new CustomEvent('fm:tasks:folder-filter', { detail: { folder } }),
        );
      }
    }
    function onOpenProjects(e: Event) {
      // task-83048f692491 — open (or focus) the singleton Projects-home tab.
      // Optional `projectId` deep-link drills straight into a project; stash it
      // on window so a freshly-mounted ProjectsPage applies it, and re-broadcast
      // so an already-mounted page reacts immediately.
      const projectId = (e as CustomEvent).detail?.projectId as string | undefined;
      const w = window as unknown as { __fmProjectsDeepLink?: string };
      if (projectId !== undefined) w.__fmProjectsDeepLink = projectId;
      dispatch({ type: 'openProjectsTab' });
      if (projectId !== undefined) {
        window.dispatchEvent(
          new CustomEvent('fm:projects:focus', { detail: { projectId } }),
        );
      }
    }
    function onOpenSettings(e: Event) {
      const section = (e as CustomEvent).detail?.section as string | undefined;
      setSettingsSection(section);
      setSettingsOpen(true);
    }
    async function onOpenWith(e: Event) {
      const detail = (e as CustomEvent).detail as { path: string; ext?: string } | undefined;
      if (!detail?.path) return;
      try {
        const picked = await fm.pickApplication();
        if (picked) setOpenWith({ path: detail.path, ext: detail.ext, appPath: picked });
      } catch (err) {
        dispatch({
          type: 'setStatus',
          msg: formatOpError('open with', err),
        });
      }
    }
    window.addEventListener('fm:openRename', onRename);
    window.addEventListener('fm:openMkdir', onMkdir);
    window.addEventListener('fm:openTouch', onTouch);
    window.addEventListener('fm:openTheme', onTheme);
    window.addEventListener('fm:openCommandPalette', onCommandPalette);
    window.addEventListener('fm:openPrivacyHelp', onPrivacyHelp);
    window.addEventListener('fm:openTutorial', onTutorial);
    window.addEventListener('fm:toggleTips', onToggleTips);
    window.addEventListener('fm:confirm', onConfirm);
    window.addEventListener('fm:openWith', onOpenWith);
    window.addEventListener('fm:newTag', onNewTag);
    window.addEventListener('fm:newDslTag', onNewDslTag);
    window.addEventListener('fm:editDslTag', onEditDslTag);
    window.addEventListener('fm:openFilterTab', onOpenFilterTab);
    window.addEventListener('fm:tagPicker', onTagPicker);
    window.addEventListener('fm:openHelp', onHelp);
    window.addEventListener('fm:openSecrets', onSecrets);
    window.addEventListener('fm:openWelcome', onWelcome);
    window.addEventListener('fm:openTask', onOpenTask);
    window.addEventListener('fm:openTasksPage', onOpenTasksPage);
    window.addEventListener('fm:openProjects', onOpenProjects);
    window.addEventListener('fm:openSettings', onOpenSettings);
    window.addEventListener('fm:openRunHistory', onOpenRunHistory);
    window.addEventListener('fm:openTaskDetail', onOpenTaskDetail);
    window.addEventListener('fm:openRunTask', onOpenRunTask);
    window.addEventListener('fm:reloadDir', onReloadDir);
    window.addEventListener('fm:setStatus', onSetStatus);
    return () => {
      window.removeEventListener('fm:openRename', onRename);
      window.removeEventListener('fm:openMkdir', onMkdir);
      window.removeEventListener('fm:openTouch', onTouch);
      window.removeEventListener('fm:openTheme', onTheme);
      window.removeEventListener('fm:openCommandPalette', onCommandPalette);
      window.removeEventListener('fm:openPrivacyHelp', onPrivacyHelp);
      window.removeEventListener('fm:openTutorial', onTutorial);
      window.removeEventListener('fm:toggleTips', onToggleTips);
      window.removeEventListener('fm:confirm', onConfirm);
      window.removeEventListener('fm:openWith', onOpenWith);
      window.removeEventListener('fm:newTag', onNewTag);
      window.removeEventListener('fm:newDslTag', onNewDslTag);
      window.removeEventListener('fm:editDslTag', onEditDslTag);
      window.removeEventListener('fm:openFilterTab', onOpenFilterTab);
      window.removeEventListener('fm:tagPicker', onTagPicker);
      window.removeEventListener('fm:openHelp', onHelp);
      window.removeEventListener('fm:openSecrets', onSecrets);
      window.removeEventListener('fm:openWelcome', onWelcome);
      window.removeEventListener('fm:openTask', onOpenTask);
      window.removeEventListener('fm:openTasksPage', onOpenTasksPage);
      window.removeEventListener('fm:openProjects', onOpenProjects);
      window.removeEventListener('fm:openSettings', onOpenSettings);
      window.removeEventListener('fm:openRunHistory', onOpenRunHistory);
      window.removeEventListener('fm:openTaskDetail', onOpenTaskDetail);
      window.removeEventListener('fm:openRunTask', onOpenRunTask);
      window.removeEventListener('fm:reloadDir', onReloadDir);
      window.removeEventListener('fm:setStatus', onSetStatus);
    };
  }, [activeTab, state.entriesByPath]);

  if (!activeTab) {
    return <div className="app">loading…</div>;
  }
  const tab = activeTab;

  // fm-b5at.10 — expiry banner for the active TypeBuild session tab. Only the
  // active tab gets the strip (backgrounded sessions still carry the phase in
  // the map and surface it when focused); the warning is hidden once dismissed.
  const activePtyId = tab.terminal?.ptyId;
  const activeExpiry =
    activePtyId != null ? expiryPhase.get(activePtyId) ?? null : null;
  const activePhase = activeExpiry?.phase ?? null;
  const showExpiryBanner =
    !!activePhase &&
    tab.terminal?.source === 'typebuild' &&
    !(activePhase === 'warning' && activePtyId != null && expiryDismissed.has(activePtyId));

  // One-click relaunch: kill the expired PTY, mint fresh, resume. A typed mint
  // failure maps to the same in-app message as the initial launch and is shown
  // inline on the banner so the user can retry; the tab repoints on success
  // (handled by the onTypebuildSessionRelaunched effect above).
  const doRelaunch = async (ptyId: number, taskId: string) => {
    setRelaunch({ ptyId, error: null });
    try {
      await fm.typebuildRelaunchSession({ ptyId, taskId });
      // Success path clears `relaunch` via the relaunched effect (repoint).
    } catch (err) {
      setRelaunch({ ptyId, error: relaunchErrorMessage(err) });
    }
  };

  const overlayApi: OverlayApi = {
    requestRename: (entry, mode = 'full') => setRenaming({ entry, mode }),
    requestMkdir: () => setMkdirOpen(true),
  };

  // fm-a9j — task tabs render an entirely different shell. The Pathbar /
  // FolderHeader / FolderList chain assumes "this tab is a folder you're
  // browsing"; a task tab is "this tab is operational, focused on a
  // task," so we swap in TaskShell. Sidebar stays visible so the user
  // can pivot between tasks; Preview is hidden because there's nothing
  // to preview from a task. The terminal pane (when attached) still
  // takes over via TerminalSplit, identical to folder tabs.
  const isTaskTab = tab.kind === 'task';
  const isTasksTab = tab.kind === 'tasks';
  const isProjectsTab = tab.kind === 'projects';
  const isEditTab = tab.kind === 'edit';
  const isBrowserTab = tab.kind === 'browser'; // SPIKE (spike/playwright-cdp)
  const isFilterTab = !!tab.boundSelector; // fm-mp1 — smart folder (folder kind)

  return (
    <OverlayCtx.Provider value={overlayApi}><div
      className="shell"
      data-view={tab.viewMode}
      data-mode={tab.terminal ? 'terminal' : 'files'}
      data-tab-kind={tab.kind}
      data-chat={tab.chat ? 'open' : undefined}
      // fm-dly3 — inline --chat-w wins over the static 380px rule in App.css so
      // the user's dragged/persisted width drives the grid column when open.
      style={tab.chat ? ({ ['--chat-w']: `${chatWidth}px` } as CSSProperties) : undefined}
    >
      <IconSprite />
      {/* title slot — owned by fm-9w0 */}
      <div className="shell__title">
        <Titlebar />
      </div>
      {/* chrome slot — Tabbar + (Pathbar | nothing). In task mode the
          Pathbar would lie about what this tab is "at," so we drop it
          and let the task header own the top edge of the main pane. */}
      <div className="shell__chrome">
        <Tabbar />
        {!isTaskTab && !isTasksTab && !isProjectsTab && !isEditTab && !isBrowserTab && (
          isFilterTab ? (
            // fm-mp1 — a filter-tab has no real cwd to navigate; show the bound
            // selector + scope instead of the synthetic trail key.
            <div className="pathbar pathbar--filter" title={tab.boundSelector}>
              <span className="pathbar__filter-icon">⧉</span>
              <span className="pathbar__filter-selector">{tab.boundSelector}</span>
              <span className="pathbar__filter-scope">
                in {tab.scopePath ? basename(tab.scopePath) || tab.scopePath : 'home'}
              </span>
            </div>
          ) : (
            <Pathbar
              path={tab.trail[tab.trail.length - 1]}
              onNavigate={(p) => setTab({ trail: [p], selected: { 0: 0 } })}
            />
          )
        )}
      </div>
      {/* side slot — Sidebar (fm-4zi) fills the reserved 240px slot.
          Hidden in preview mode (fm-wq6) so the preview pane can claim
          the real estate. Hidden in terminal mode (fm-jtu) so the
          terminal goes full-bleed. Stays visible on a single task tab — the
          tasks list is the user's pivot surface. fm-vlmj — hidden on the
          all-tasks page (isTasksTab): that page is its own inbox (list +
          detail), so the global Sidebar was redundant clutter; skipping the
          render also avoids mounting its location/source-polling effects. */}
      {tab.viewMode !== 'preview' && !tab.terminal && !isEditTab && !isBrowserTab && !isTasksTab && !isProjectsTab && <Sidebar />}
      {/* main slot — folder tabs render the recessed file plate; task
          tabs render TaskShell (header / actions / folder context).
          TerminalSplit wraps both so embedded terminals work in either
          mode. */}
      <main className="shell__main">
        {/* fm-b5at.10 — TypeBuild MCP session-expiry strip, pinned over the
            active session's terminal. 'warning' is a dismissible heads-up;
            'expired' offers a one-click relaunch (the user never sees the raw
            MCP error underneath). PHI-free. */}
        {showExpiryBanner && activePtyId != null && activePhase && (
          <TypebuildSessionBanner
            phase={activePhase}
            busy={relaunch?.ptyId === activePtyId && !relaunch.error}
            error={relaunch?.ptyId === activePtyId ? relaunch.error : null}
            onRestart={() => {
              const taskId = activeExpiry?.taskId;
              if (taskId) void doRelaunch(activePtyId, taskId);
            }}
            onDismiss={() =>
              setExpiryDismissed((prev) => {
                const next = new Set(prev);
                next.add(activePtyId);
                return next;
              })
            }
          />
        )}
        <TerminalSplit
          tabs={state.tabs}
          activeIndex={state.activeTab}
        >
          {taskDialog ? (
            <TaskComposer
              {...taskDialog}
              onClose={() => setTaskDialog(null)}
            />
          ) : isTaskTab ? (
            <TaskShell tabIndex={state.activeTab} />
          ) : isTasksTab ? (
            <TasksPage />
          ) : isProjectsTab ? (
            <ProjectsPage />
          ) : isEditTab ? (
            // Edit tabs render in the persistent EditSplit layer below so
            // they survive tab switches; nothing to draw here.
            null
          ) : isBrowserTab ? (
            <BrowserPane tabId={tab.id} url={tab.browserUrl || 'https://example.com'} />
          ) : (
            <>
              <FolderHeader />
              <RunProgressBanner cwd={tab.trail[lastCol(tab)]} />
              <FilterChip />
              <FolderList />
            </>
          )}
        </TerminalSplit>
        {/* Persistent edit-tab layer (mirrors TerminalSplit): keeps every
            edit tab's Milkdown editor mounted so switching back is instant. */}
        <EditSplit tabs={state.tabs} activeIndex={state.activeTab} />
      </main>
      {/* preview slot — Preview (fm-fda) fills the reserved 340px slot.
          In tag view (fm-uns) the slot hosts TagInspector instead, so the
          user can browse, toggle, and combine tags without leaving the file
          list. Hidden in terminal mode (fm-jtu) and in task mode (no
          file selected = nothing to preview). */}
      {!tab.terminal && !isTaskTab && !isTasksTab && !isProjectsTab && !isEditTab && !isBrowserTab && (
        tab.viewMode === 'tag' ? <TagInspector /> : <Preview />
      )}
      {/* chat slot — fm-dly3 agent chat panel, docked right. Renders for the
          active tab when its chat is open (works in folder + edit modes). */}
      {tab.chat && (
        <ChatPanel
          tabIndex={state.activeTab}
          chat={tab.chat}
          onResizeDelta={onChatResizeDelta}
          onResizeEnd={onChatResizeEnd}
        />
      )}
      {/* status slot — ModeLine stacked above Statusbar. Hidden in
          terminal mode so the terminal pane reaches the bottom edge. */}
      {!tab.terminal && !isEditTab && !isBrowserTab && (
        <div className="shell__status">
          <ModeLine />
          <Statusbar />
        </div>
      )}

      {/* Floating paste affordance (fm-3km) — visible whenever the user has
          staged files via Copy / Move verbs or yy / dd chords. Renders above
          the main content but below modals. */}
      <PasteChip />

      {/* Update available — fetches GitHub Releases on a 24h cadence and
          shows a quiet bottom-left pill when a newer version is out.
          User upgrades via `brew upgrade --cask breezefile` (copy button). */}
      <UpdateChip />

      {/* Rotating "did you know" tips in the bottom-right. Helps first-
          time users discover the verb prompt without an in-your-face
          tutorial. Dismissible forever. */}
      <TipsChip />

      {renaming && (
        <RenameOverlay
          entry={renaming.entry}
          mode={renaming.mode}
          onClose={() => setRenaming(null)}
          onCommit={async (newName) => {
            if (!newName || newName === renaming.entry.name) {
              setRenaming(null);
              return;
            }
            const to = pathJoin(dirname(renaming.entry.path), newName);
            // Let the overlay surface errors inline — rethrow so it stays
            // open and the user can fix the name without retyping.
            await fm.rename(renaming.entry.path, to);
            await refreshActive();
            requestAnimationFrame(() => celebratePaths([to]));
            dispatch({ type: 'setStatus', msg: `renamed → ${newName}` });
            setRenaming(null);
          }}
        />
      )}

      {mkdirOpen && (
        <MkdirOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setMkdirOpen(false)}
          onCommit={async (name) => {
            if (!name) { setMkdirOpen(false); return; }
            const dir = pathJoin(tab.trail[tab.trail.length - 1], name);
            await fm.mkdir(dir);
            // Drop the user straight into the folder they just made, rather
            // than leaving them in the parent with the new entry merely selected.
            await openPath(dir);
            dispatch({ type: 'setStatus', msg: `created ${name}/` });
            setMkdirOpen(false);
          }}
        />
      )}

      {touchOpen && (
        <TouchOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setTouchOpen(false)}
          onCommit={async (name) => {
            if (!name) { setTouchOpen(false); return; }
            const to = pathJoin(tab.trail[tab.trail.length - 1], name);
            await fm.touch(to);
            if (isEditablePath(name)) {
              // Editable files open straight into the in-app editor — same
              // routing as goRight/:note — so you can start writing immediately.
              dispatch({ type: 'openEditTab', path: to, focus: true });
              dispatch({ type: 'pushRecentFile', path: to });
            } else {
              await refreshActive();
              focusEntryByName(name);
              requestAnimationFrame(() => celebratePaths([to]));
            }
            dispatch({ type: 'setStatus', msg: `created ${name}` });
            setTouchOpen(false);
          }}
        />
      )}

      {quickFindOpen && (
        <QuickFindOverlay
          onClose={() => setQuickFindOpen(false)}
        />
      )}

      {shellOpen && (
        <ShellOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setShellOpen(false)}
        />
      )}

      {state.mode === 'command' && (
        <ChipPrompt
          initialFilter={state.modeBuffer}
          initialVerbId={state.modeVerb}
          onClose={() => dispatch({ type: 'setMode', mode: 'normal' })}
        />
      )}
      {themeOpen && <ThemePicker onClose={() => setThemeOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {welcomeOpen && <Welcome onClose={() => setWelcomeOpen(false)} />}
      {privacyHelpOpen && <PrivacyHelpDialog onClose={() => setPrivacyHelpOpen(false)} />}
      {tutorialOpen && (
        <Tutorial key={tutorialNonce} onClose={() => setTutorialOpen(false)} />
      )}
      {settingsOpen && (
        <Settings
          onClose={() => {
            setSettingsOpen(false);
            setSettingsSection(undefined);
          }}
          initialSection={settingsSection as never}
        />
      )}
      {confirm && (
        <ConfirmDialog
          {...confirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {openWith && (
        <OpenWithDialog
          filePath={openWith.path}
          ext={openWith.ext}
          appPath={openWith.appPath}
          onClose={() => setOpenWith(null)}
        />
      )}
      {newTagOpen && (
        <CreateTagOverlay
          onClose={() => setNewTagOpen(false)}
          onCommit={(name, color, criterion) => {
            const id = newTagId(name);
            const taken = new Set<string>();
            for (const t of state.customTags) if (t.key) taken.add(t.key);
            const key = assignTagKey(name, taken);
            dispatch({
              type: 'createCustomTag',
              tag: { id, name: name.trim(), color, criterion, key, createdAt: Date.now() },
            });
            dispatch({ type: 'addTagViz', id });
            dispatch({
              type: 'setStatus',
              msg: `tag created: ${name}${key ? ` (key: ${key})` : ''}`,
            });
            setNewTagOpen(false);
          }}
        />
      )}
      {dslTagOpen && (
        <DslTagOverlay
          editId={dslTagOpen.editId ?? null}
          onClose={() => setDslTagOpen(null)}
          onSaved={(msg) => dispatch({ type: 'setStatus', msg })}
        />
      )}
      {tagPicker && (
        <TagPicker mode={tagPicker} onClose={() => setTagPicker(null)} />
      )}
      {helpOpen && (
        <HelpTour
          initialSlide={helpOpen.slide}
          onClose={() => setHelpOpen(null)}
        />
      )}
      {secretsOpen && <SecretsPanel onClose={() => setSecretsOpen(false)} />}
      {runHistoryFor && (
        <RunHistoryDialog
          taskId={runHistoryFor}
          onClose={() => setRunHistoryFor(null)}
        />
      )}
      {taskDetail && (
        <TaskDetailDrawer
          task={taskDetail.task}
          initialTab={taskDetail.initialTab}
          onClose={() => setTaskDetail(null)}
        />
      )}
      {runTaskCwd && (
        <RunTaskModal cwd={runTaskCwd} onClose={() => setRunTaskCwd(null)} />
      )}
      {chatLaunch && (
        <ChatLaunchOptions
          agentLabel={chatLaunch.agentLabel}
          targetLabel={chatLaunch.targetLabel}
          options={chatLaunch.options}
          onClose={() => setChatLaunch(null)}
          onStart={(flags) => {
            const req = chatLaunch;
            setChatLaunch(null);
            void openChatPanel({
              tabIndex: req.tabIndex,
              target: req.target,
              agentId: req.agentId,
              extraFlags: flags,
              dispatch,
            }).then((res) => {
              if (!res.ok && res.needsAgent) {
                dispatch({
                  type: 'setStatus',
                  msg: 'Your default chat agent is unavailable — pick another',
                });
                setSettingsSection('chat-agent');
                setSettingsOpen(true);
              }
            });
          }}
        />
      )}
    </div>
    </OverlayCtx.Provider>
  );
}

type CriterionField =
  | 'manual'
  | 'extIn'
  | 'sizeOver'
  | 'sizeUnder'
  | 'modifiedWithin'
  | 'modifiedBefore'
  | 'nameContains'
  | 'nameMatches'
  | 'kindIs';

const CRITERION_LABELS: Record<CriterionField, string> = {
  manual: 'No rule — apply manually',
  extIn: 'Extension is one of…',
  sizeOver: 'Size larger than…',
  sizeUnder: 'Size smaller than…',
  modifiedWithin: 'Modified within…',
  modifiedBefore: 'Modified more than…',
  nameContains: 'Name contains…',
  nameMatches: 'Name matches regex…',
  kindIs: 'Kind is…',
};

function CreateTagOverlay({
  onClose,
  onCommit,
}: {
  onClose: () => void;
  onCommit: (name: string, color: string, criterion?: CustomTagCriterion) => void;
}) {
  const [name, setName] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  const [field, setField] = useState<CriterionField>('extIn');
  // One generic value buffer per field type; we read whatever's relevant
  // for the chosen field at submit time. Separate state to avoid stomping
  // on the user's typed values when they switch field momentarily.
  const [extValue, setExtValue] = useState('');
  const [sizeValue, setSizeValue] = useState('');
  const [daysValue, setDaysValue] = useState('');
  const [textValue, setTextValue] = useState('');
  const [kindValue, setKindValue] = useState<'dir' | 'file'>('file');
  const { exit, state } = useOverlayExit(onClose);

  function buildCriterion(): CustomTagCriterion | undefined {
    switch (field) {
      case 'manual':
        return undefined;
      case 'extIn': {
        const values = extValue
          .split(/[,\s]+/)
          .map((v) => v.trim().toLowerCase().replace(/^\./, ''))
          .filter(Boolean);
        return values.length > 0 ? { field: 'extIn', values } : undefined;
      }
      case 'sizeOver': {
        const mb = Number(sizeValue);
        return Number.isFinite(mb) && mb > 0 ? { field: 'sizeOver', mb } : undefined;
      }
      case 'sizeUnder': {
        const mb = Number(sizeValue);
        return Number.isFinite(mb) && mb > 0 ? { field: 'sizeUnder', mb } : undefined;
      }
      case 'modifiedWithin': {
        const days = Number(daysValue);
        return Number.isFinite(days) && days > 0 ? { field: 'modifiedWithin', days } : undefined;
      }
      case 'modifiedBefore': {
        const days = Number(daysValue);
        return Number.isFinite(days) && days > 0 ? { field: 'modifiedBefore', days } : undefined;
      }
      case 'nameContains':
        return textValue.trim() ? { field: 'nameContains', text: textValue.trim() } : undefined;
      case 'nameMatches':
        return textValue.trim() ? { field: 'nameMatches', pattern: textValue.trim() } : undefined;
      case 'kindIs':
        return { field: 'kindIs', value: kindValue };
    }
  }

  const submit = () => {
    if (!name.trim()) return;
    const crit = buildCriterion();
    if (field !== 'manual' && !crit) return; // need a value for non-manual rules
    onCommit(name, TAG_PALETTE[colorIdx].color, crit);
  };

  const valueInput = (() => {
    switch (field) {
      case 'manual':
        return (
          <div className="tagform__hint-line">
            Files won't be tagged automatically. Use <kbd>tag</kbd> to add them.
          </div>
        );
      case 'extIn':
        return (
          <input
            className="overlay__input"
            value={extValue}
            placeholder="pdf, jpg, mov"
            onChange={(e) => setExtValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        );
      case 'sizeOver':
      case 'sizeUnder':
        return (
          <div className="tagform__row">
            <input
              className="overlay__input tagform__num"
              type="number"
              min={0}
              step="0.1"
              value={sizeValue}
              placeholder="4"
              onChange={(e) => setSizeValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <span className="tagform__unit">MB</span>
          </div>
        );
      case 'modifiedWithin':
      case 'modifiedBefore':
        return (
          <div className="tagform__row">
            <input
              className="overlay__input tagform__num"
              type="number"
              min={0}
              step="1"
              value={daysValue}
              placeholder="7"
              onChange={(e) => setDaysValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <span className="tagform__unit">days</span>
          </div>
        );
      case 'nameContains':
        return (
          <input
            className="overlay__input"
            value={textValue}
            placeholder="screenshot"
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        );
      case 'nameMatches':
        return (
          <input
            className="overlay__input"
            value={textValue}
            placeholder="^IMG_\\d+"
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        );
      case 'kindIs':
        return (
          <div className="tagform__row" role="radiogroup" aria-label="Kind">
            <button
              type="button"
              role="radio"
              aria-checked={kindValue === 'file'}
              className={`tagform__pill${kindValue === 'file' ? ' tagform__pill--on' : ''}`}
              onClick={() => setKindValue('file')}
            >
              File
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kindValue === 'dir'}
              className={`tagform__pill${kindValue === 'dir' ? ' tagform__pill--on' : ''}`}
              onClick={() => setKindValue('dir')}
            >
              Folder
            </button>
          </div>
        );
    }
  })();

  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box overlay__box--tag" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New tag</div>
        <input
          autoFocus
          className="overlay__input"
          value={name}
          placeholder="e.g. heavy-pdfs, this-week, screenshots"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        <div className="overlay__palette" role="radiogroup" aria-label="Tag color">
          {TAG_PALETTE.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={colorIdx === i}
              aria-label={c.name}
              className={[
                'overlay__swatch',
                colorIdx === i && 'overlay__swatch--on',
              ].filter(Boolean).join(' ')}
              style={{ background: c.color }}
              onClick={() => setColorIdx(i)}
              title={c.name}
            />
          ))}
        </div>

        <div className="overlay__label tagform__divider">Rule</div>
        <select
          className="overlay__input tagform__select"
          value={field}
          onChange={(e) => setField(e.target.value as CriterionField)}
        >
          {(Object.keys(CRITERION_LABELS) as CriterionField[]).map((f) => (
            <option key={f} value={f}>
              {CRITERION_LABELS[f]}
            </option>
          ))}
        </select>
        {valueInput}

        <div className="overlay__hint">
          Combine tags with <b>Match all</b> / <b>Match any</b> in the inspector to
          build complex filters. Enter to create · Esc to cancel.
        </div>
      </div>
    </div>
  );
}

function RenameOverlay({
  entry,
  mode,
  onClose,
  onCommit,
}: {
  entry: Entry;
  mode: RenameMode;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError(humanizeError(err).message);
      setBusy(false);
    }
  };
  const label =
    mode === 'append'
      ? 'Append to name'
      : mode === 'prepend'
        ? 'Prepend to name'
        : mode === 'beforeExt'
          ? 'Rename (keep extension)'
          : 'Rename';
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">{label}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
          onFocus={(e) => {
            const el = e.currentTarget;
            const n = value;
            const dot = n.lastIndexOf('.');
            const hasExt = dot > 0 && entry.kind !== 'dir';
            if (mode === 'append') {
              el.setSelectionRange(n.length, n.length);
            } else if (mode === 'prepend') {
              el.setSelectionRange(0, 0);
            } else if (mode === 'beforeExt' && hasExt) {
              el.setSelectionRange(dot, dot);
            } else if (hasExt) {
              el.setSelectionRange(0, dot);
            } else {
              el.select();
            }
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function MkdirOverlay({
  cwd,
  onClose,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError(humanizeError(err).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New folder in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function TouchOverlay({
  cwd,
  onClose,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError(humanizeError(err).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New file in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          placeholder="untitled.txt"
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function QuickFindOverlay({ onClose }: { onClose: () => void }) {
  const { state, activeTab, setTab, dispatch } = useStore();
  const [value, setValue] = useState('');
  const { exit, state: overlayState } = useOverlayExit(onClose);
  if (!activeTab) return null;
  const tab = activeTab;

  function doFind(q: string) {
    const path = tab.trail[lastCol(tab)];
    const entries = visibleEntries(state.entriesByPath[path], tab);
    const needle = q.toLowerCase();
    const idx = entries.findIndex((e) => e.name.toLowerCase().includes(needle));
    if (idx >= 0) {
      setTab({ selected: { ...tab.selected, [lastCol(tab)]: idx } });
    }
    dispatch({ type: 'setLastFind', query: q });
  }

  return (
    <div className="overlay" data-state={overlayState} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">Quick find</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            doFind(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // open the currently-selected entry
              const entries = visibleEntries(state.entriesByPath[tab.trail[lastCol(tab)]], tab);
              const entry = currentEntry(tab, entries);
              if (entry) {
                if (entry.kind === 'dir') {
                  setTab({
                    trail: [...tab.trail, entry.path],
                    selected: { ...tab.selected, [tab.trail.length]: 0 },
                  });
                } else {
                  fm.open(entry.path);
                }
              }
              exit();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
      </div>
    </div>
  );
}

function ShellOverlay({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { dispatch } = useStore();
  const [value, setValue] = useState('');
  const { exit, state } = useOverlayExit(onClose);
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">shell in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="echo hi"
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              try {
                await fm.runCommand(cwd, value);
                dispatch({ type: 'setStatus', msg: `$ ${value}` });
              } catch (err) {
                dispatch({
                  type: 'setStatus',
                  msg: formatOpError('shell', err),
                });
              }
              exit();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
      </div>
    </div>
  );
}

export function App() {
  return (
    <PlatformProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </PlatformProvider>
  );
}
