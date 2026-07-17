// ─── SPIKE (spike/playwright-cdp): the operator session window ───────────────
//
// A single window split into TWO panes: the browser page on the LEFT and the
// agent's Claude-Code terminal on the RIGHT, divided by ONE resizer. The whole
// window is the Breeze React bundle (loaded with `#operator=<ptyId>&view=<id>`,
// rendered by src/components/OperatorSession.tsx); the page itself is a child
// WebContentsView created via electron/browser/views.ts — the SAME backend the
// in-app browser tab uses — so the operator pane has full PARITY (Record +
// saved-login autofill + credential capture). The React surface
// (BrowserSurface) positions + drives it over the shared `browser:*` IPC keyed
// by its view id, and Playwright drives the page over CDP.
//
// This REPLACES the old floating, draggable chat overlay (a WebContentsView
// docked bottom-right over a full-window page) — there is no more
// overlay:move / overlay:resize machinery. The single resizer + a minimize
// button (1/3 ↔ 0) live in the React chrome; their geometry is persisted there.
//
// Singleton window + singleton page view. When opened WITHOUT a ptyId (the
// HTTP `open-browser` control verb) we still render the operator chrome but with
// no terminal pane, so the CDP target is a clean page view either way.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { killManagedPty, isManagedPtyAlive } from '../ipc';
// The shared embedded-browser view backend (one registry drives both the in-app
// tab and this operator pane). Credential capture + record + autofill all ride
// the view created here — no operator-specific browser IPC any more.
import { createBrowserView, getBrowserView, destroyBrowserView } from './views';
// The themed "task starting" splash shown until the agent's first real
// navigation (task-3a49fb5adf24) — replaces the old example.com placeholder.
import {
  splashDataUrl,
  errorSplashDataUrl,
  isSplashUrl,
  resolveStartUrl,
  SPLASH_DEFAULT_THEME,
} from './start-splash';

// The bundle is ESM — `__dirname` doesn't exist. Derive it from this chunk's
// URL (resolves to dist-electron/, where preload.mjs lives) so the operator
// chrome gets the same preload as the main window.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let browserWin: BrowserWindow | null = null;
// The id of the shared browser view living in the LEFT pane of the operator
// window (registered in electron/browser/views.ts). Baked into the operator
// chrome's `view=<id>` hash so the React surface drives it over `browser:*`.
// Tracked at module scope so a window REUSE (a fresh Start) re-bakes the SAME
// id — the view is parented to the window's contentView and survives the chrome
// reload, so the browser pane stays live while only the terminal re-attaches.
let operatorViewId: number | null = null;
// Last URL requested for the page (used when the view is created). Default is
// the themed "task starting" splash (task-3a49fb5adf24) rather than a
// meaningless example.com — the agent drives the first REAL navigation via the
// helper's `goto`, which replaces this. Starts on the default theme; the
// operator renderer reports the user's actual chosen theme via
// `operator:set-theme` once it mounts (re-themes the splash if still showing).
let splashTheme: string = SPLASH_DEFAULT_THEME;
let pendingUrl = splashDataUrl(splashTheme);
// The agent PTY this operator session mirrors. Tracked so that closing the
// window — via the single CLOSE button OR the OS window chrome — tears the PTY
// down TOO (task-c4064f8a4994), routing through the existing onSessionExit /
// release / keep-alive flow. null for the no-agent open-browser verb.
let operatorPtyId: number | null = null;
// task-6fc9e503623e — a per-current-window box holding the pty THAT window's
// close handler is allowed to kill. Distinct from `operatorPtyId` (which the
// NEXT launch reassigns before the OLD window closes); see the close-handler
// comment in openBrowserWindow. Re-pointed on window reuse.
let ownedPtyRef: { current: number | null } = { current: null };

// The window title for the CURRENT session, e.g. "TypeBuild Operator — Fix
// login bug". Falls back to the bare "TypeBuild Operator" when no task/label
// is known yet (the optimistic splash window, or the plain open-browser
// verb). Re-applied on every navigation via the page-title-updated guard
// below, since the operator chrome's static <title>TypeBuild</title> would
// otherwise clobber it the instant the page (re)loads.
let operatorTitle = 'TypeBuild Operator';

/** The live operator/browser window, or null if none is open. */
export function getBrowserWindow(): BrowserWindow | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin : null;
}

/**
 * task-3f0c6a6abe41 — the MAIN app window to host an interactive session tab,
 * i.e. a live window that is NOT the operator window. runTaskInteractive used
 * to fall back to `getAllWindows().find(w => !w.isDestroyed())` when there was
 * no focused window — the case for a gesture-less auto-continue tick right
 * after the previous step's operator window closed. That find could pick the
 * OPERATOR window (or one mid-teardown), and binding the new pty to its
 * webContents (or reading `.id` on a dead one) threw BEFORE the spawn, so the
 * claim was held but no claude process ever started. Handing the launcher a
 * deterministic, live MAIN window removes that race. Returns null only when
 * the app genuinely has no non-operator window with a live webContents.
 */
export function getPrimaryHostWindow(): BrowserWindow | null {
  const operator = browserWin;
  const alive = (w: BrowserWindow): boolean => {
    if (w.isDestroyed()) return false;
    try {
      const wc = w.webContents;
      return !!wc && !wc.isDestroyed() && !wc.isCrashed();
    } catch {
      return false;
    }
  };
  // Prefer a live window that is NOT the operator window; fall back to any
  // live window (covers a headless/operator-only edge, though the launcher
  // then hosts the tab there rather than failing outright).
  const windows = BrowserWindow.getAllWindows();
  return (
    windows.find((w) => w !== operator && alive(w)) ??
    windows.find((w) => alive(w)) ??
    null
  );
}

/** The id of the browser view living in the operator window's left pane —
 *  the page an external agent (Claude Code, curl) drives over CDP. Lets
 *  `/app/browser/*` HTTP routes default to "the agent's own browser" when no
 *  explicit view id is given. Null if no operator window is open. */
export function getOperatorViewId(): number | null {
  return operatorViewId;
}

/** Open (or focus) the operator session window: browser LEFT, Claude Code
 *  terminal RIGHT, one resizer. When `ptyId` is given the right pane mirrors
 *  that PTY's terminal; without it the window is just the browser pane (the
 *  HTTP `open-browser` verb). Reuse does NOT renavigate — the agent drives
 *  navigation via the helper's `goto`.
 *
 *  task-207afa3fcec2 — TAKEOVER GUARD. The window is a process-wide
 *  singleton, but there are now TWO independent callers that can adopt a
 *  brand-new ptyId into it: a TypeBuild task launch (interactive.ts, via
 *  typebuild.ts) and the task-less ad-hoc Ctrl+B session
 *  (adhoc-browser.ts). Each has its OWN reuse guard for repeat calls with
 *  its OWN ptyId (a second Start / a second Ctrl+B just focuses), but
 *  neither knows about the OTHER's session — so if session A's window is
 *  open and session B calls in with a genuinely different, still-alive
 *  ptyId, the old code silently re-pointed the terminal pane out from under
 *  A (and the close handler's owned-pty box with it), hijacking whatever A
 *  was doing. We now ask before doing that: if declined, the window stays
 *  on the original session and the NEW ptyId is left un-adopted (its pty
 *  keeps running headless in the managed-pty registry — the caller spawned
 *  it before it could know whether the window would be free — but nothing
 *  visibly steals A's session). Returns true iff this call ended up hosted
 *  in (or already reflected by) the window; false if a takeover was
 *  offered and declined. Async ONLY on the confirm path — every other path
 *  returns synchronously-resolved. */
export async function openBrowserWindow(
  url?: string,
  ptyId?: number,
  launching?: boolean,
  sessionTitle?: string,
): Promise<boolean> {
  // Resolve the requested url through the single chokepoint: empty/missing OR a
  // stale example.com placeholder both become the themed splash (in the current
  // splashTheme) rather than overriding it — example.com must never load on task
  // start (task-d85d23f3aea4). interactive.ts used to pass a literal
  // 'https://example.com' here; the resolver neutralizes that and any
  // example.com start_url that reaches the `open-browser` verb. A REAL url
  // (the agent's explicit `goto` target) still passes through.
  const resolvedUrl = resolveStartUrl(url, splashTheme);
  const prevPtyId = operatorPtyId;
  const existing = getBrowserWindow();
  // A takeover is only a real conflict when: the window already exists, the
  // caller is adopting a DIFFERENT pty than the one it currently mirrors, AND
  // that prior pty is still a live process (not just a stale id nobody
  // cleared — e.g. a task that finished but whose window is still up showing
  // the "done" splash presents no live session to steal).
  if (
    existing &&
    ptyId != null &&
    ptyId !== prevPtyId &&
    prevPtyId != null &&
    isManagedPtyAlive(prevPtyId)
  ) {
    const priorLabel = operatorTitle.replace(/^TypeBuild Operator(?: — )?/, '').trim();
    const nextLabel = sessionTitle?.trim();
    const { response } = await dialog.showMessageBox(existing, {
      type: 'warning',
      buttons: ['Cancel', 'Take Over'],
      defaultId: 0,
      cancelId: 0,
      title: 'Operator session already running',
      message: priorLabel
        ? `An operator session for "${priorLabel}" is still active.`
        : 'Another operator session is still active.',
      detail: `${nextLabel ? `Starting "${nextLabel}"` : 'This new session'} would replace it in the one operator window — the running session keeps executing, but you won't see it here anymore. Take over the window?`,
    });
    if (response !== 1) {
      // Declined: leave the window exactly as it is, pointed at the prior
      // session. The new ptyId is NOT adopted — operatorPtyId/ownedPtyRef
      // stay on the prior session so its close handler still kills the
      // right pty.
      existing.focus();
      return false;
    }
    // Taking over: fall through to the normal repoint below, but bring the
    // NOW-ORPHANED prior pty down first. It already lost its only visible
    // window and has no way back into one (the singleton just adopted a
    // different session) — leaving it running invisibly would be a stray
    // background `claude` process the user can't see or stop.
    try {
      killManagedPty(prevPtyId);
    } catch {
      /* already gone */
    }
  }
  pendingUrl = resolvedUrl;
  if (ptyId != null) operatorPtyId = ptyId;
  operatorTitle = sessionTitle?.trim()
    ? `TypeBuild Operator — ${sessionTitle.trim()}`
    : 'TypeBuild Operator';
  if (existing) {
    existing.setTitle(operatorTitle);
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    // Re-point the terminal pane to a NEW session. The ptyId is baked into the
    // React chrome's `#operator=<ptyId>` hash at load time, so a reused window
    // keeps mirroring the FIRST session's (now-dead) PTY unless we reload it
    // with the new id. The page view is parented to the window's contentView
    // (not the chrome's webContents), so it survives this reload — we re-bake
    // the SAME view id so the browser pane stays untouched; only the Claude
    // terminal re-attaches.
    if (ptyId != null && ptyId !== prevPtyId) {
      // NOTE (task fix/orphaned-agent-ptys): reaching here with a still-live
      // prevPtyId would STRAND that agent — repointing the chrome leaves it
      // running with no pane mirroring it and no close handler owning it
      // (~440MB / ~40% CPU each, accumulating until the box needs a reboot).
      // The takeover guard above is what upholds that: it either kills a live
      // prevPtyId (on Take Over) or returns early (on Cancel), so by this
      // point prevPtyId is always already dead. Keep it that way — if that
      // guard is ever relaxed, this repoint needs its own kill.
      //
      // task-6fc9e503623e — re-point the REUSED window's owned-pty box to the
      // new session so its close handler kills the current pty, not the prior
      // one (and never the successor).
      ownedPtyRef.current = ptyId;
      loadOperatorChrome(existing, ptyId, operatorViewId);
    }
    return true;
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: operatorTitle,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // Must match the main window (main.ts): the bundled preload.mjs is loaded
      // as an ES module and contains a `require`, which only resolves under the
      // sandboxed preload loader's require-shim. With sandbox:false Electron
      // loads it as a native ESM where `require` is undefined → the preload
      // throws ("require is not defined in ES module scope"), window.fm is never
      // exposed, and OperatorSession/Terminal crash to a blank window.
      sandbox: true,
      contextIsolation: true,
    },
  });
  browserWin = win;
  // The operator chrome is the same bundle as the main window and carries the
  // same static <title>TypeBuild</title>, which fires page-title-updated and
  // clobbers our task-specific title the instant the chrome (re)loads (e.g.
  // loadOperatorChrome on reuse). Re-assert the current operatorTitle instead
  // of letting the page win, mirroring the profile-suffix guard in main.ts.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(operatorTitle);
  });
  // task-6fc9e503623e — the pty THIS window currently hosts, captured per
  // window (a closure ref), NOT read from the mutable module-level
  // `operatorPtyId`. ROOT-CAUSE FIX for the auto-continue instant-exit race:
  // the close handler below used to kill `operatorPtyId`, which by the time an
  // OLD operator window finally fired its 'close' had ALREADY been reassigned
  // (openBrowserWindow line ~130) to the NEXT step's freshly-spawned pty — so
  // closing the just-finished window killed the NEW session milliseconds after
  // it spawned (pty id returned, no claude process survived). Scoping the kill
  // to the pty this window actually owns means a closing window can never take
  // down its successor's session. `updateOperatorOwnedPty` re-points this on
  // reuse.
  ownedPtyRef = { current: ptyId ?? null };
  const myOwned = ownedPtyRef;
  // ONE elegant close (task-c4064f8a4994): whichever way the window goes away —
  // the in-chrome CLOSE button (operator:close → win.close()) or the OS window
  // chrome — tear the agent PTY down TOO so both halves end as one action.
  // Killing the PTY fires its onExit, which for a TypeBuild session routes into
  // onSessionExit (stopKeepAlive + the "release this task?" prompt). Idempotent:
  // if the renderer already killed the PTY first, killManagedPty is a no-op.
  win.on('close', () => {
    const owned = myOwned.current;
    if (owned != null) {
      try {
        killManagedPty(owned);
      } catch {
        /* already gone */
      }
    }
  });
  win.on('closed', () => {
    // Explicitly tear down the page view AND drop its registry entry. Electron
    // does not always GC a child view when its window closes, which otherwise
    // leaks one live off-screen page (a stray CDP target) + a BrowserRec per
    // operator session.
    if (operatorViewId != null) destroyBrowserView(operatorViewId);
    if (browserWin === win) {
      browserWin = null;
      operatorViewId = null;
      operatorPtyId = null;
    }
  });

  // Create the page view FIRST (eagerly, in MAIN) so the agent's CDP target
  // exists before the React chrome mounts: api-server (`open-browser`) and
  // agents/interactive.ts open this window then immediately drive Playwright.
  // fill:'rect' so the page honors the measured left-pane width and STOPS AT
  // THE DIVIDER (unlike an in-app tab, which fills to the window edge).
  operatorViewId = createBrowserView(win, { url: pendingUrl, fill: 'rect' });

  // The whole window is the operator React chrome. It renders a left
  // BrowserSurface bound to the view id above (measuring its placeholder +
  // streaming bounds over `browser:bounds`) and a right terminal pane.
  loadOperatorChrome(win, ptyId, operatorViewId, launching);

  fillScreen(win);
  return true;
}

// task-1b3eeb1aae1f — OPTIMISTIC LAUNCH. Pop the operator window showing the
// "task starting" splash the INSTANT Start / Run all / matrix-Run is clicked —
// BEFORE the pre-spawn network waterfall (mint + operator-instructions +
// context-bundle + project + getTask + N× resolveTaskDataRef) and before the
// pty spawns. Without this the window is only created by openBrowserWindow AFTER
// that whole >10s chain, so the user stares at nothing. The later
// openBrowserWindow(undefined, ptyId) call (once the pty is live) REUSES this
// same window and re-points its terminal pane to the real session — so the human
// sees a window in <~500ms and the terminal fills in underneath when ready.
//
// Reuse-safe: an already-open operator window is focused/restored; a STALE
// splash on its page pane (e.g. the prior chain step's "done" card) is refreshed
// back to the live "starting" splash so a new step reads as starting. It NEVER
// clobbers a real page the agent navigated to (isSplashUrl guards that) and
// never touches the terminal pane / owned pty — the pty repoint stays the sole
// job of openBrowserWindow(undefined, ptyId).
export function openSessionStartingSplash(): void {
  const fresh = splashDataUrl(splashTheme);
  const existing = getBrowserWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    const wc = (operatorViewId != null ? getBrowserView(operatorViewId) : null)?.webContents;
    if (wc && !wc.isDestroyed() && isSplashUrl(wc.getURL())) {
      pendingUrl = fresh;
      void wc.loadURL(fresh);
    }
    return;
  }
  // No operator window yet — pop it NOW showing the splash, with NO terminal
  // pane (ptyId omitted) until the real pty attaches via the later
  // openBrowserWindow(undefined, ptyId). `launching` makes the right pane read
  // "Starting session…" for the whole wait instead of "No agent session"
  // (task-7ba4409eeb5c).
  pendingUrl = fresh;
  // No ptyId on this call (the optimistic pre-spawn splash), so it can never
  // hit the takeover-guard branch above — nothing to await.
  void openBrowserWindow(undefined, undefined, true);
}

// task-1b3eeb1aae1f — tear the optimistic session-starting splash back down when
// the launch fails BEFORE a pty ever attached (mint / no-window / an early throw
// in launchSession). GUARDED: only closes while the operator window is still
// splash-only (operatorPtyId == null), so it can never kill a window already
// hosting a live (or just-spawned) session — that path leaves the window up and
// the row surfaces the error instead.
export function closeSessionStartingSplash(): void {
  const win = getBrowserWindow();
  if (!win) return;
  if (operatorPtyId != null) return;
  win.close();
}

// QA 2026-07-13 — the failed-launch counterpart: with operator-always hosting
// the splash pops for EVERY Start, so tearing it down on a pre-pty launch
// failure (mint timeout, no hostable window) read as "the operator crashed"
// and the reason hid on the roster row. Instead, flip the still-splash-only
// window to the error card and LEAVE IT UP — same guard as close (never
// touches a window already hosting a session), and the error card carries the
// splash sentinel so the next Start's openSessionStartingSplash refreshes it
// back to the live "starting" card. `message` must be NON-PHI (humanized
// machine reason, never task content).
export function failSessionStartingSplash(message: string): void {
  const win = getBrowserWindow();
  if (!win) return;
  if (operatorPtyId != null) return;
  const wc = (operatorViewId != null ? getBrowserView(operatorViewId) : null)?.webContents;
  if (!wc || wc.isDestroyed()) {
    win.close();
    return;
  }
  const fresh = errorSplashDataUrl(splashTheme, message);
  pendingUrl = fresh;
  void wc.loadURL(fresh);
  win.focus();
}

// Load (or reload) the operator React chrome with the `#operator=<ptyId>&view=<id>`
// hash that pins which PTY the right pane mirrors and which shared browser view
// the left pane drives. Reused on a fresh Start to re-point an already-open
// window at the new session while keeping the same browser view.
function loadOperatorChrome(
  win: BrowserWindow,
  ptyId?: number,
  viewId?: number | null,
  launching?: boolean,
): void {
  let hash = ptyId != null ? `operator=${ptyId}` : 'operator';
  if (viewId != null) hash += `&view=${viewId}`;
  // task-7ba4409eeb5c — mark an OPTIMISTIC-launch open (window up, pty not yet
  // spawned) so the right pane shows "Starting session…" instead of "No agent
  // session." Only set on the starting-splash path; a real pty attach reloads
  // WITHOUT it (ptyId present), and the plain open-browser verb never sets it.
  if (launching && ptyId == null) hash += '&launching=1';
  if (VITE_DEV_SERVER_URL) {
    void win.webContents.loadURL(`${VITE_DEV_SERVER_URL}#${hash}`);
  } else {
    void win.webContents.loadFile(
      path.join(process.env.APP_ROOT || '', 'dist', 'index.html'),
      { hash },
    );
  }
}

// Size the operator window to the full work area of the display under the
// Breeze window. Best-effort: some window managers (Wayland) ignore setBounds.
function fillScreen(bwin: BrowserWindow): void {
  const breeze = BrowserWindow.getAllWindows().find(
    (w) => w !== bwin && !w.isDestroyed(),
  );
  const anchor = breeze ? breeze.getBounds() : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const wa = display.workArea;
  try {
    bwin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  } catch {
    /* best-effort; leave the window free-floating on a degraded WM */
  }
}

// The operator renderer reports the user's chosen UI theme on mount
// (task-3a49fb5adf24). If the page view is STILL showing the start splash (the
// agent hasn't navigated yet), re-render it in that theme so the splash matches
// the client. Once the agent issues a real `goto`, the page is no longer a
// splash and we leave it alone. Idempotent: skip if the theme didn't change.
// task-8997b15a37d9 — the splash otherwise NEVER clears for a task that never
// touches the browser: it only swaps away on a real agent `goto` (isSplashUrl
// check in browser/views.ts's navigation path). Called from the agent PTY's
// exit handler (electron/agents/interactive.ts) so the operator pane reflects
// real session state instead of spinning forever, including after the whole
// session has already finished. No-ops if the page already navigated away
// (isSplashUrl is false) or if this exit doesn't belong to the CURRENT
// operator session (a stale/relaunched-away ptyId).
export function markSessionEnded(ptyId: number): void {
  if (ptyId !== operatorPtyId) return;
  const wc = (operatorViewId != null ? getBrowserView(operatorViewId) : null)?.webContents;
  if (!wc || wc.isDestroyed() || !isSplashUrl(wc.getURL())) return;
  void wc.loadURL(splashDataUrl(splashTheme, /* done */ true));
}

ipcMain.on('operator:set-theme', (_e, theme: string) => {
  if (typeof theme !== 'string' || theme === splashTheme) return;
  splashTheme = theme;
  const next = splashDataUrl(splashTheme);
  // Keep pendingUrl current so a view (re)created later uses the right theme.
  if (isSplashUrl(pendingUrl)) pendingUrl = next;
  const wc = (operatorViewId != null ? getBrowserView(operatorViewId) : null)?.webContents;
  if (wc && isSplashUrl(wc.getURL())) void wc.loadURL(next);
});

// Single CLOSE action (task-c4064f8a4994): tear down the page view + the window
// together. The renderer kills the PTY first (so its onExit → onSessionExit →
// release/keep-alive routing fires deterministically), then asks us to close the
// window here. The window's `close` handler ALSO kills the PTY as a backstop
// (idempotent), so the OS window chrome's X is just as elegant.
ipcMain.on('operator:close', () => {
  const win = getBrowserWindow();
  if (win) win.close();
});
