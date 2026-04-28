// fm-jtu — terminal mount point.
//
// Persistent terminal layer (tmux-style): we mount a Terminal for *every*
// tab that has one and only show the active tab's. xterm instances stay
// alive across tab switches so scrollback is preserved — switching back
// to a long-running Claude session shows the full history, not just
// whatever has streamed since you came back.
//
// When the active tab has no terminal we hide the whole layer (children
// render in its place) but keep the inactive-tab terminals mounted
// underneath. Ctrl+D inside a shell exits the pty, which fires onExit →
// closeTerminal and the file-manager layout snaps back for that tab.
import { type ReactNode } from 'react';
import { Terminal } from './Terminal';
import { useStore } from '../store';
import type { Tab } from '../types';

type Props = {
  tabs: Tab[];
  activeIndex: number;
  /** FolderList / TaskShell etc. — rendered only when the active tab has
   *  no terminal. Inactive tabs' children are never rendered (they're
   *  not the visible tab). */
  children: ReactNode;
};

export function TerminalSplit({ tabs, activeIndex, children }: Props) {
  const { dispatch } = useStore();
  const activeTab = tabs[activeIndex];
  const activeHasTerm = !!activeTab?.terminal;

  return (
    <>
      <div
        className="terminal-fullbleed"
        style={{ display: activeHasTerm ? 'flex' : 'none' }}
      >
        {tabs.map((t, i) => {
          if (!t.terminal) return null;
          const isActive = i === activeIndex;
          return (
            <div
              key={t.id}
              className="terminal-layer"
              style={{ display: isActive ? 'flex' : 'none' }}
            >
              <Terminal
                // Keying on ptyId means a fresh terminal (after :term-close
                // + :term) remounts xterm; reusing the same pty preserves
                // the instance — which is the whole point of this layer.
                key={t.terminal.ptyId}
                ptyId={t.terminal.ptyId}
                cwd={t.terminal.cwd}
                isActive={isActive}
                onExit={() => dispatch({ type: 'closeTerminal', tabIndex: i })}
                onAttention={(state) =>
                  dispatch({
                    type: 'setTerminalAttention',
                    tabIndex: i,
                    attention: state,
                  })
                }
              />
            </div>
          );
        })}
      </div>
      {!activeHasTerm && children}
    </>
  );
}
