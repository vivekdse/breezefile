// fm-jtu — terminal mount point for the active tab.
//
// When the tab has no terminal we render the children as-is (the regular
// FolderHeader + FilterChip + FolderList stack). When a terminal IS open
// the children disappear entirely — the whole main area is given over to
// the terminal. The shell layout (App.css) also collapses sidebar and
// preview in this mode, so the user effectively gets a full-bleed
// terminal with only Tabbar + Pathbar above it. Ctrl+D inside the shell
// exits the pty, which fires onExit → closeTerminal and the file-manager
// layout snaps back.
import { type ReactNode } from 'react';
import { Terminal } from './Terminal';
import { useStore } from '../store';
import type { Tab } from '../types';

type Props = {
  tab: Tab;
  tabIndex: number;
  isActive: boolean;
  children: ReactNode; // FolderList + chrome
};

export function TerminalSplit({ tab, tabIndex, isActive, children }: Props) {
  const { dispatch } = useStore();
  const term = tab.terminal;

  if (!term) {
    return <>{children}</>;
  }

  return (
    <div className="terminal-fullbleed">
      <Terminal
        // Keying on ptyId means a fresh terminal (after :term-close + :term)
        // remounts xterm; reusing the same pty preserves the instance.
        key={term.ptyId}
        ptyId={term.ptyId}
        cwd={term.cwd}
        isActive={isActive}
        onExit={() => dispatch({ type: 'closeTerminal', tabIndex })}
        onAttention={(state) =>
          dispatch({
            type: 'setTerminalAttention',
            tabIndex,
            attention: state,
          })
        }
      />
    </div>
  );
}
