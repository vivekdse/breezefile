// SPIKE (spike/playwright-cdp): the in-browser agent chat widget.
//
// Rendered (instead of the full App) in the WebContentsView the browser window
// docks over the page — see electron/browser/window.ts and main.tsx. Shows ONLY
// the agent's terminal for `ptyId` (mirroring its stream), is DRAGGABLE by its
// header, COLLAPSES to a bubble, and flags when Claude is WAITING on the user.
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Terminal } from './Terminal';
import { fm } from '../bridge';
import './AgentOverlay.css';

// Must match PANEL (default) in electron/browser/window.ts; BUBBLE is the
// collapsed size. The expanded panel is drag-resizable and the chosen size
// persists (breeze.overlaySize), so PANEL is only the first-run default.
const PANEL = { w: 380, h: 560 };
const BUBBLE = { w: 64, h: 64 };
const PANEL_MIN = { w: 240, h: 200 };
const PANEL_MAX = { w: 1000, h: 1000 };
const OVERLAY_SIZE_KEY = 'breeze.overlaySize';

const clampPanel = (w: number, h: number) => ({
  w: Math.max(PANEL_MIN.w, Math.min(PANEL_MAX.w, Math.round(w))),
  h: Math.max(PANEL_MIN.h, Math.min(PANEL_MAX.h, Math.round(h))),
});
function readPanelSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(OVERLAY_SIZE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { w?: number; h?: number };
      if (typeof s.w === 'number' && typeof s.h === 'number')
        return clampPanel(s.w, s.h);
    }
  } catch {
    /* unparseable / unavailable — fall back to default */
  }
  return PANEL;
}

export function AgentOverlay({ ptyId }: { ptyId: number }) {
  const [waiting, setWaiting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // fm-dly3 — persisted expanded-panel size; restored on expand and on mount.
  const sizeRef = useRef(readPanelSize());

  useEffect(() => {
    fm.termMirror(ptyId);
    const off = fm.onTermFg((id, _busy, _comm, state) => {
      if (id === ptyId) setWaiting(state === 'waiting');
    });
    // Apply the persisted size — the native view opens at the PANEL default.
    fm.overlayResize(sizeRef.current.w, sizeRef.current.h);
    return () => {
      off();
      fm.termUnmirror(ptyId);
    };
  }, [ptyId]);

  const setMode = (next: boolean) => {
    setCollapsed(next);
    const s = next ? BUBBLE : sizeRef.current;
    fm.overlayResize(s.w, s.h);
  };

  // fm-dly3 — resize the panel via the top-left grip. The widget is docked
  // bottom-right and main pins that corner, so dragging up/left grows it into
  // the screen. movementX/Y deltas (not absolute coords) stay accurate as the
  // native view bounds shift under the pointer. Coalesced to one IPC/frame.
  const resizeRaf = useRef<number | null>(null);
  const onResizePointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation(); // don't let the title-bar drag handler move the widget
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizePointerMove = (e: ReactPointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const s = clampPanel(
      sizeRef.current.w - e.movementX,
      sizeRef.current.h - e.movementY,
    );
    sizeRef.current = s;
    if (resizeRaf.current == null) {
      resizeRaf.current = requestAnimationFrame(() => {
        resizeRaf.current = null;
        fm.overlayResize(sizeRef.current.w, sizeRef.current.h);
      });
    }
  };
  const onResizePointerUp = (e: ReactPointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    try {
      localStorage.setItem(OVERLAY_SIZE_KEY, JSON.stringify(sizeRef.current));
    } catch {
      /* unavailable — size still applies for this session */
    }
  };

  // Drag the native view by streaming pointer deltas to main. On the bubble, a
  // pointer-up with little movement counts as a click → expand.
  const drag = useRef({ down: false, moved: 0 });
  const onPointerDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { down: true, moved: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current.down) return;
    drag.current.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    fm.overlayMove(e.movementX, e.movementY);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const wasClick = drag.current.moved < 5;
    drag.current.down = false;
    if (collapsed && wasClick) setMode(false);
  };

  if (collapsed) {
    return (
      <button
        className={`agent-bubble${waiting ? ' agent-bubble--waiting' : ''}`}
        title="Open Claude"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {waiting ? '!' : '✦'}
      </button>
    );
  }

  return (
    <div className={`agent-overlay${waiting ? ' agent-overlay--waiting' : ''}`}>
      {/* fm-dly3 — top-left resize grip; grows up-and-left from the bottom-right
          dock (main pins that corner). */}
      <div
        className="agent-overlay__resize"
        title="Drag to resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
      />
      <div
        className="agent-overlay__bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="agent-overlay__title">Claude</span>
        {waiting && <span className="agent-overlay__badge">needs you</span>}
        <button
          className="agent-overlay__min"
          title="Collapse"
          // Don't let the drag handler capture the click.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMode(true)}
        >
          —
        </button>
      </div>
      <div className="agent-overlay__term">
        <Terminal ptyId={ptyId} cwd="" isActive />
      </div>
    </div>
  );
}
