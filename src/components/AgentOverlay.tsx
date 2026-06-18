// SPIKE (spike/playwright-cdp): the in-browser agent chat widget.
//
// Rendered (instead of the full App) in the WebContentsView the browser window
// docks over the page — see electron/browser/window.ts and main.tsx. Shows ONLY
// the agent's terminal for `ptyId` (mirroring its stream), is DRAGGABLE by its
// header, COLLAPSES to a bubble, and flags when Claude is WAITING on the user.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { fm } from '../bridge';
import './AgentOverlay.css';

// Must match PANEL in electron/browser/window.ts; BUBBLE is the collapsed size.
const PANEL = { w: 380, h: 560 };
const BUBBLE = { w: 64, h: 64 };

export function AgentOverlay({ ptyId }: { ptyId: number }) {
  const [waiting, setWaiting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fm.termMirror(ptyId);
    const off = fm.onTermFg((id, _busy, _comm, state) => {
      if (id === ptyId) setWaiting(state === 'waiting');
    });
    return () => {
      off();
      fm.termUnmirror(ptyId);
    };
  }, [ptyId]);

  const setMode = (next: boolean) => {
    setCollapsed(next);
    const s = next ? BUBBLE : PANEL;
    fm.overlayResize(s.w, s.h);
  };

  // Drag the native view by streaming pointer deltas to main. On the bubble, a
  // pointer-up with little movement counts as a click → expand.
  const drag = useRef({ down: false, moved: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { down: true, moved: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.down) return;
    drag.current.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    fm.overlayMove(e.movementX, e.movementY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
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
