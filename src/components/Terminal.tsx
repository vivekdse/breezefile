// fm-jtu — Embedded xterm.js + node-pty pane.
//
// The PTY itself lives in the main process (electron/ipc.ts); this component
// only owns the renderer-side xterm.js instance + its IPC plumbing. The
// renderer never sees a child_process — it talks to a numeric pty id.
//
// Theme integration (fm-36e): the xterm theme is rebuilt from CSS custom
// properties on the document root so it inherits whatever Breeze theme is
// active. A MutationObserver on `data-theme` triggers a live swap.
//
// Attention detection (fm-fux): we tap the data stream for cursor-visibility
// SGR codes (\x1b[?25l hides — generating, \x1b[?25h shows — waiting) and
// fall back to BEL / OSC-9 / activity-stopped heuristics. The signal is
// only meaningful when the tab is backgrounded, so the parent gates the
// dispatch on `isActive`.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { fm } from '../bridge';
import './Terminal.css';

export type AttentionState = 'idle' | 'busy' | 'bell' | null;

type Props = {
  /** Existing pty id; if undefined the component spawns a new pty in `cwd`. */
  ptyId?: number;
  cwd: string;
  /** Called once spawn completes with the new pty id. */
  onSpawn?: (id: number) => void;
  onExit?: (id: number, code: number) => void;
  /** Attention transitions, fired only while `isActive` is false. */
  onAttention?: (state: AttentionState) => void;
  /** Whether this tab is the active tab. Drives attention reporting. */
  isActive: boolean;
  /** Auto-typed once after spawn — used by launcher verbs (:claude etc.). */
  initialCommand?: string;
};

// Build an xterm ITheme from the current document's CSS custom properties.
// The Breeze theme tokens we read map cleanly onto xterm's slots — we don't
// need to define a parallel terminal palette. ANSI 0–15 keep their canonical
// hues so `ls --color` and TUI apps still look right; only the chrome
// (background, foreground, cursor, selection) tracks the file manager.
function readThemeFromDoc(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw || fallback;
  };
  // Prefer the "panel" surface so the terminal reads as a paired sibling
  // to the sidebar/preview rather than a hole in the page.
  const bg = v('--panel', v('--bg-1', '#161819'));
  const fg = v('--text-on-panel', v('--ink', '#e6e6e6'));
  const accent = v('--accent', '#7aa2f7');
  const muted = v('--text-muted', v('--fg-2', '#9aa0a6'));
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: accent + '40',
    // ANSI defaults — kept consistent across themes so program output
    // doesn't shift hue when the user toggles dark/light.
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
  };
  void muted; // reserved for future statusline accents
}

export function Terminal({
  ptyId: existingPtyId,
  cwd,
  onSpawn,
  onExit,
  onAttention,
  isActive,
  initialCommand,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(existingPtyId ?? null);
  // Buffer for data that arrives before our spawn() promise has resolved
  // (the main process may pump the shell's first prompt down the IPC
  // channel before our invoke roundtrip completes). Keyed by id so we
  // only flush bytes that belong to *our* pty.
  const pendingByIdRef = useRef<Map<number, string[]>>(new Map());
  const dataUnsubRef = useRef<(() => void) | null>(null);
  const exitUnsubRef = useRef<(() => void) | null>(null);
  // Cursor-visibility tracker: many TUIs (claude code, claude, vim, less)
  // hide the cursor while generating/redrawing and show it while waiting
  // for input. This is the strongest "needs attention" signal we have.
  const cursorVisibleRef = useRef<boolean>(true);
  const lastAttentionRef = useRef<AttentionState>(null);
  const isActiveRef = useRef<boolean>(isActive);
  isActiveRef.current = isActive;
  const initialCmdRef = useRef<string | null>(initialCommand ?? null);

  // Mount xterm.js once. The pty either already exists (rehydration) or we
  // spawn a fresh one keyed to this cwd.
  useEffect(() => {
    if (!wrapRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      // macOS option-as-meta so option+f/b skip words — matches how
      // people use Terminal.app / iTerm by default.
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: readThemeFromDoc(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon());
    term.open(wrapRef.current);
    // WebGL renderer is an order of magnitude faster for high-throughput
    // streams (build logs, ls of huge dirs). It can fail to init on older
    // GPUs / certain virtualization setups, so try-catch and let xterm
    // fall back to canvas/DOM rendering.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // canvas fallback is automatic
    }
    xtermRef.current = term;
    fitRef.current = fit;

    // Initial fit needs the wrapper to have a size; defer one frame.
    // Focus aggressively so keystrokes go to the pty's hidden textarea
    // instead of being caught by the global useKeyboard handler — that's
    // what prevented typing into the terminal in the first cut.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* not yet measurable */ }
      term.focus();
    });
    // Belt-and-suspenders re-focus after the chip prompt's overlay
    // teardown completes (its exit animation can land focus back on the
    // document body a few frames after the verb fires).
    const focusTimer = setTimeout(() => term.focus(), 80);

    // Subscribe to data/exit events keyed by ptyId. We register before
    // spawning so we don't miss the first burst (shell prompt).
    dataUnsubRef.current = fm.onTermData((id, data) => {
      if (ptyIdRef.current == null) {
        // Spawn hasn't resolved yet — buffer per-id so we replay only
        // our own pty's prefix once we learn the assigned id.
        const buf = pendingByIdRef.current.get(id) ?? [];
        buf.push(data);
        pendingByIdRef.current.set(id, buf);
        return;
      }
      if (id !== ptyIdRef.current) return;
      term.write(data);
      // Attention detection lives in the global monitor in App.tsx (it
      // sees data for every tab — active or backgrounded — and uses
      // activity-based timing rather than cursor-visibility codes,
      // which Claude Code emits on every streamed chunk).
    });
    exitUnsubRef.current = fm.onTermExit((id, code) => {
      if (id !== ptyIdRef.current) return;
      term.writeln(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m`);
      onExit?.(id, code);
    });

    // PTY → xterm: keystrokes typed in xterm forward to the pty.
    const onDataDisp = term.onData((data) => {
      const id = ptyIdRef.current;
      if (id == null) return;
      fm.termWrite(id, data);
    });
    const onResizeDisp = term.onResize(({ cols, rows }) => {
      const id = ptyIdRef.current;
      if (id == null) return;
      fm.termResize(id, cols, rows);
    });

    // Spawn (or attach to existing) pty.
    let cancelled = false;
    (async () => {
      if (ptyIdRef.current != null) {
        // Re-attach: ask for a resize so the new xterm dimensions take.
        try { fit.fit(); } catch { /* noop */ }
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      try {
        const id = await fm.termSpawn({ cwd, cols, rows });
        if (cancelled) {
          await fm.termKill(id).catch(() => {});
          return;
        }
        ptyIdRef.current = id;
        // Drain any data the pty sent before we knew our id. Other
        // pending entries (data for *other* ptys belonging to other
        // Terminal instances) stay in the map so their owners can
        // collect them when their own spawn resolves.
        const buffered = pendingByIdRef.current.get(id);
        if (buffered) {
          for (const chunk of buffered) term.write(chunk);
          pendingByIdRef.current.delete(id);
        }
        onSpawn?.(id);
        if (initialCmdRef.current) {
          // Tiny defer so the shell finishes printing its first prompt
          // before we type — otherwise the launcher line ends up
          // sandwiched into the prompt's title escape.
          setTimeout(() => {
            const cmd = initialCmdRef.current;
            initialCmdRef.current = null;
            if (cmd) fm.termWrite(id, cmd + '\r');
          }, 60);
        }
      } catch (err) {
        term.writeln(
          `\r\n\x1b[31m[failed to start shell: ${(err as Error).message}]\x1b[0m`,
        );
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(focusTimer);
      onDataDisp.dispose();
      onResizeDisp.dispose();
      dataUnsubRef.current?.();
      exitUnsubRef.current?.();
      // Note: we deliberately do NOT kill the pty on unmount. The pty
      // lifecycle is owned by the tab.terminal state — :term-close kills
      // it, the pty's own onExit handler kills it, and the main process
      // kills orphans when the renderer goes away. Component remount
      // (e.g. tab switch) must not yank the shell out from under work
      // the user is doing.
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live theme swap (fm-36e). Re-derive the xterm theme whenever the host
  // app's theme changes. We watch `data-theme` on the document root —
  // App.tsx's StoreProvider sets that attribute when the user runs `:theme`.
  useEffect(() => {
    const apply = () => {
      const t = xtermRef.current;
      if (!t) return;
      t.options.theme = readThemeFromDoc();
      // The WebGL renderer caches cell backgrounds; without an explicit
      // refresh the previous theme's bg can linger on already-painted
      // rows after a swap (most visible on dark→light transitions).
      try { t.refresh(0, t.rows - 1); } catch { /* noop */ }
    };
    apply();
    const obs = new MutationObserver(() => apply());
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  // Resize observer — refit whenever the pane changes size (user drags
  // splitter, window resizes, devtools toggles).
  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(() => {
      try { fitRef.current?.fit(); } catch { /* noop */ }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Focus the xterm whenever this tab becomes active. Without this the
  // user has to click into the pane after every tab switch.
  useEffect(() => {
    if (isActive) {
      // Defer one frame so a tab switch + show doesn't race the layout.
      requestAnimationFrame(() => xtermRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  function reportAttention(state: AttentionState) {
    if (lastAttentionRef.current === state) return;
    lastAttentionRef.current = state;
    // Active and backgrounded tabs both report — the tint reflects the
    // terminal's live state (busy/idle), not a "you haven't seen this"
    // flag. Bell is the exception (cleared on activation by App.tsx),
    // but reporting it here is still correct.
    onAttention?.(state);
  }

  return (
    <div
      className="terminal-pane"
      // Clicking anywhere in the pane (gutter, padding, scrollback) puts
      // focus on xterm's helper textarea so the user can immediately
      // start typing without having to click the cursor row exactly.
      onMouseDown={() => xtermRef.current?.focus()}
    >
      <div className="terminal-pane__inner" ref={wrapRef} />
    </div>
  );
}
