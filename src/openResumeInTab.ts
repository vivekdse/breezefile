// fm-7zx0 follow-up — replace "copy resume" affordances with "open in
// a new tab + run the resume command in an embedded terminal there",
// so the user actually lands in the headless trace inside Breeze
// instead of having to paste the command into an external shell.
//
// The new tab is appended (its index is `state.tabs.length` *before*
// the dispatch). After the pty spawns, we send the resume command +
// CR via fm.termWrite — pty stdin is buffered, so the shell processes
// it whether or not xterm has mounted yet.

import { useStore, makeTab } from './store';
import { spawnTerminal } from './terminalSpawn';
import { fm } from './bridge';

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || '/' : trimmed;
}

export function useOpenResumeInTab() {
  const { state, dispatch } = useStore();

  return async function openResumeInTab(
    folder: string | null,
    conversationId: string,
    label?: string,
  ): Promise<void> {
    if (!folder) {
      dispatch({
        type: 'setStatus',
        msg: 'no folder on this run — cannot open resume',
      });
      return;
    }
    const newTabIndex = state.tabs.length;
    const sessionLabel = label || basename(folder);
    dispatch({ type: 'newTab', tab: makeTab(folder) });
    try {
      const ptyId = await spawnTerminal({ cwd: folder, sessionLabel });
      dispatch({
        type: 'openTerminal',
        tabIndex: newTabIndex,
        ptyId,
        cwd: folder,
        label: sessionLabel,
      });
      fm.termWrite(ptyId, `claude --resume ${conversationId}\r`);
      dispatch({
        type: 'setStatus',
        msg: `resumed run in new tab · ${sessionLabel}`,
      });
    } catch (err) {
      dispatch({
        type: 'setStatus',
        msg: `open resume failed: ${(err as Error).message}`,
      });
    }
  };
}
