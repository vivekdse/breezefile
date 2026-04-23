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

  // Keyboard-hint trail — keys relevant to NORMAL browsing.
  // When a selection exists we surface the drag-out + paste hints instead
  // of the generic ones, since those are the verbs the user is likely to
  // reach for next.
  const hints: Array<{ keys: string[]; label: string }> =
    markedCount > 0
      ? [
          { keys: ['d'], label: 'drag out' },
          { keys: ['y'], label: 'yank' },
          { keys: ['p'], label: 'paste' },
          { keys: [':'], label: 'command' },
        ]
      : [
          { keys: ['⌘K'], label: 'command' },
          { keys: ['y'], label: 'yank' },
          { keys: ['space'], label: 'mark' },
          { keys: ['d'], label: 'drag' },
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
