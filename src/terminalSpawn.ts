// fm-hzo — central terminal-spawn helper.
//
// All in-app terminal spawns (TaskShell, ChipPrompt :term, launchers,
// Terminal fallback) route through here so the tmux-default Settings
// toggle has one place to take effect. When tmux mode is on, spawn
// `tmux new-session -A -s <name>` instead of the user's $SHELL — `-A`
// makes it create-if-missing / attach-if-exists, which means two tabs
// with the same label share a single tmux session.
import { fm } from './bridge';

const STORAGE_KEY = 'fm-state-v1';

function isTmuxEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { useTmux?: boolean };
    return parsed.useTmux === true;
  } catch {
    return false;
  }
}

// tmux session names cannot contain '.' or ':' (used as window/pane
// separators). Spaces work but read awkwardly in `tmux ls`. Map
// anything that isn't [A-Za-z0-9_-] to '_' and prefix 'fm-' so an
// empty / numeric-only label still produces a valid, namespaced name.
export function tmuxSessionName(label: string): string {
  const cleaned = (label || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return `fm-${cleaned || 'tab'}`;
}

export async function spawnTerminal(opts: {
  cwd: string;
  sessionLabel: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}): Promise<number> {
  const { cwd, sessionLabel, cols, rows, env } = opts;
  if (isTmuxEnabled()) {
    return fm.termSpawn({
      cwd,
      cols,
      rows,
      env,
      shell: 'tmux',
      // -c sets the session's starting cwd on creation; ignored on attach
      // (existing session keeps its own cwd, which is the point).
      args: [
        'new-session',
        '-A',
        '-s',
        tmuxSessionName(sessionLabel),
        '-c',
        cwd,
      ],
    });
  }
  return fm.termSpawn({ cwd, cols, rows, env });
}
