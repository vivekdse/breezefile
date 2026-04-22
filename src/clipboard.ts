// Shared paste helper (fm-3km).
//
// Both the `pp` keyboard chord and the floating PasteChip dispatch paste
// through this single function so the semantics — destination = current cwd,
// move clears yank, copy persists — stay consistent across surfaces.

import type { Dispatch } from 'react';
import { fm } from './bridge';
import { basename } from './actions';
import { celebratePaths } from './motion-utils';
import type { YankEntry } from './types';

type PasteDeps = {
  yank: YankEntry[];
  cwd: string;
  overwrite?: boolean;
  dispatch: Dispatch<any>;
  refreshActive: () => Promise<void>;
};

/** Payload broadcast on `fm:paste-success` after a paste completes. */
export type PasteSuccessDetail = {
  count: number;
  mode: YankEntry['mode'];
  destPaths: string[];
};

export async function runPaste({
  yank,
  cwd,
  overwrite = false,
  dispatch,
  refreshActive,
}: PasteDeps): Promise<void> {
  if (yank.length === 0) {
    dispatch({ type: 'setStatus', msg: 'nothing to paste' });
    return;
  }
  try {
    const { renamed } = await fm.paste(
      yank.map((y) => ({ src: y.path, dst: cwd, mode: y.mode, overwrite })),
    );
    // Move clears the clipboard (the originals are gone); copy persists so
    // the user can drop the same files in multiple places.
    const mode = yank[0].mode;
    if (mode === 'move') dispatch({ type: 'setYank', yank: [] });
    await refreshActive();
    const suffix = renamed > 0 ? ` (${renamed} renamed to avoid collision)` : '';
    dispatch({
      type: 'setStatus',
      msg: `pasted ${yank.length} item${yank.length === 1 ? '' : 's'}${suffix}`,
    });
    // Celebrate the just-pasted rows + broadcast so the PasteChip can
    // flip to its success state and self-dismiss. rAF waits for the
    // next paint so the new rows are in the DOM before we pulse them.
    const destPaths = yank.map((y) => `${cwd === '/' ? '' : cwd}/${basename(y.path)}`);
    requestAnimationFrame(() => {
      celebratePaths(destPaths);
      window.dispatchEvent(
        new CustomEvent<PasteSuccessDetail>('fm:paste-success', {
          detail: { count: yank.length, mode, destPaths },
        }),
      );
    });
  } catch (err) {
    dispatch({ type: 'setStatus', msg: `paste failed: ${(err as Error).message}` });
  }
}

