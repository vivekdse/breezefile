import { useStore } from '../store';
import { visibleEntries } from '../actions';
import './Statusbar.css';

export function Statusbar() {
  const { state, activeTab } = useStore();
  if (!activeTab) return null;

  const cwd = activeTab.trail[activeTab.trail.length - 1];
  const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
  const dirs = entries.filter((e) => e.kind === 'dir').length;
  const files = entries.length - dirs;
  const marked = Object.keys(activeTab.marks).length;
  const yanked = state.yank.length;

  return (
    <div className="statusbar">
      <div className="statusbar__left">
        <span className="statusbar__pill">{state.mode.toUpperCase()}</span>
        <span className="statusbar__meta">
          {entries.length} items · {dirs} dirs · {files} files
          {marked > 0 && ` · ${marked} marked`}
          {yanked > 0 && ` · ${yanked} in clipboard`}
        </span>
      </div>
      <div className="statusbar__right">
        <span className="statusbar__hint">
          <kbd>hjkl</kbd> nav · <kbd>H</kbd>
          <kbd>L</kbd> history · <kbd>space</kbd> mark · <kbd>yy</kbd>
          <kbd>pp</kbd> · <kbd>dd</kbd>
          <kbd>dD</kbd> · <kbd>/</kbd>
          <kbd>n</kbd>/<kbd>N</kbd> · <kbd>:</kbd> · <kbd>?</kbd> help
        </span>
      </div>
    </div>
  );
}
