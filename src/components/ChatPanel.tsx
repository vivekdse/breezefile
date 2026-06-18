// fm-dly3 — right-docked agent chat panel. Hosts a PTY (via the shared
// Terminal component) running an agent CLI anchored to the active tab's
// folder or document. Mounted in the `chat` grid slot for the active tab;
// the pty itself lives in the main process, so switching tabs and back
// reattaches to the same session.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Terminal } from './Terminal';
import { useStore } from '../store';
import { fm } from '../bridge';
import './ChatPanel.css';

type Props = {
  tabIndex: number;
  chat: NonNullable<import('../types').Tab['chat']>;
  // fm-dly3 — drag-resize: report horizontal pointer deltas while dragging the
  // left-edge gutter (dragging left ⇒ wider), and a one-shot end to persist.
  onResizeDelta: (dx: number) => void;
  onResizeEnd: () => void;
};

export function ChatPanel({ tabIndex, chat, onResizeDelta, onResizeEnd }: Props) {
  const { dispatch } = useStore();

  const close = () => {
    void fm.termKill(chat.ptyId).catch(() => {});
    dispatch({ type: 'closeChat', tabIndex });
  };

  // fm-dly3 — left-edge resize gutter. Use pointer capture + movementX deltas
  // (not absolute clientX) so it stays accurate while the OS window grows
  // underneath the pointer during the drag.
  const dragging = useRef(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    if (e.movementX) onResizeDelta(e.movementX);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onResizeEnd();
  };

  // No header row: the panel is the terminal, full-bleed. The old title bar
  // (💬 + label) read as redundant chrome and its emoji glyph was the source
  // of the stray tofu rectangle. The close affordance is kept as a small
  // floating button in the corner instead of a full bar.
  return (
    <aside className="chat-panel" aria-label="Agent chat">
      {/* fm-dly3 — drag the left edge to resize the panel (and grow the window). */}
      <div
        className="chat-panel__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        title="Drag to resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <button
        type="button"
        className="chat-panel__close"
        onClick={close}
        title="Close chat"
        aria-label="Close chat"
      >
        ×
      </button>
      <div className="chat-panel__body">
        <Terminal
          key={chat.ptyId}
          ptyId={chat.ptyId}
          cwd={chat.cwd}
          isActive
          onExit={close}
          onAttention={(attention) =>
            dispatch({ type: 'setChatAttention', tabIndex, attention })
          }
        />
      </div>
    </aside>
  );
}
