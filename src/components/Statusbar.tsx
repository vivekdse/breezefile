import { useStore } from '../store';
import { visibleEntries } from '../actions';
import { formatSize } from '../sort';
import './Statusbar.css';

export function Statusbar() {
  const { state, activeTab } = useStore();
  if (!activeTab) return null;

  const cwd = activeTab.trail[activeTab.trail.length - 1];
  const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
  const markedCount = entries.reduce(
    (n, e) => (activeTab.marks[e.path] ? n + 1 : n),
    0,
  );
  const yanked = state.yank.length;

  // Sum sizes: when something is marked we report the selection size;
  // otherwise the combined size of visible files in this folder.
  const totalSize = entries.reduce(
    (sum, e) => sum + (e.kind === 'file' ? e.size : 0),
    0,
  );
  const selectedSize = entries.reduce(
    (sum, e) =>
      activeTab.marks[e.path] && e.kind === 'file' ? sum + e.size : sum,
    0,
  );

  const mode = state.mode.toUpperCase();
  const summary =
    markedCount > 0
      ? `${markedCount} of ${entries.length} selected · ${formatSize(selectedSize)}`
      : `${entries.length} items · ${formatSize(totalSize)}`;

  // Keyboard hints — only the two affordances that are still real after the
  // shift to the verb-first model: Space marks the cursor item, `:` opens
  // the verb palette empty. Everything else is reachable by typing any
  // letter (which opens the palette pre-filtered).
  const hints: Array<{ keys: string[]; label: string }> = [
    { keys: ['space'], label: 'mark' },
    { keys: [':'], label: 'actions' },
  ];

  return (
    <div className="statusbar">
      <span className="statusbar__mode">{mode}</span>
      <span className="statusbar__summary tnum-oldstyle">{summary}</span>
      {yanked > 0 && (
        <span className="statusbar__clip tnum-oldstyle">
          {yanked} in clipboard
        </span>
      )}
      <span className="sp" />
      {hints.map((h, i) => (
        <span key={i} className="statusbar__hint">
          {h.keys.map((k, j) => (
            <kbd key={j}>{k}</kbd>
          ))}{' '}
          {h.label}
        </span>
      ))}
      <button
        type="button"
        className="statusbar__help"
        onClick={() => window.dispatchEvent(new CustomEvent('fm:openHelp'))}
        title="Open the help tour (slides)"
      >
        Help
      </button>
    </div>
  );
}
