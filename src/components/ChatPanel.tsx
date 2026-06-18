// fm-dly3 — right-docked agent chat panel. Hosts a PTY (via the shared
// Terminal component) running an agent CLI anchored to the active tab's
// folder or document. Mounted in the `chat` grid slot for the active tab;
// the pty itself lives in the main process, so switching tabs and back
// reattaches to the same session.
import { Terminal } from './Terminal';
import { useStore } from '../store';
import { fm } from '../bridge';
import './ChatPanel.css';

type Props = {
  tabIndex: number;
  chat: NonNullable<import('../types').Tab['chat']>;
};

export function ChatPanel({ tabIndex, chat }: Props) {
  const { dispatch } = useStore();

  const close = () => {
    void fm.termKill(chat.ptyId).catch(() => {});
    dispatch({ type: 'closeChat', tabIndex });
  };

  // No header row: the panel is the terminal, full-bleed. The old title bar
  // (💬 + label) read as redundant chrome and its emoji glyph was the source
  // of the stray tofu rectangle. The close affordance is kept as a small
  // floating button in the corner instead of a full bar.
  return (
    <aside className="chat-panel" aria-label="Agent chat">
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
