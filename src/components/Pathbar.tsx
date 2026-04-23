import { useStore } from '../store';
import './Pathbar.css';

type Props = {
  path: string;
  onNavigate: (path: string) => void;
};

export function Pathbar({ path, onNavigate }: Props) {
  const { dispatch, activeTab, goBack } = useStore();
  const canGoBack = (activeTab?.history.length ?? 0) > 0;
  const segments = path.split('/').filter(Boolean);

  function navTo(i: number) {
    const target = '/' + segments.slice(0, i + 1).join('/');
    onNavigate(target);
  }

  return (
    <div className="pathbar">
      <div className="pathbar__crumbs" role="navigation" aria-label="Path">
        <button className="pathbar__crumb" onClick={() => onNavigate('/')}>
          /
        </button>
        {segments.map((seg, i) => (
          <div key={`${i}-${seg}`} className="pathbar__crumb-wrap">
            <button className="pathbar__crumb" onClick={() => navTo(i)}>
              {seg}
            </button>
            {i < segments.length - 1 && (
              <span className="pathbar__sep" aria-hidden>
                /
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="pathbar__spacer" />
      <div className="pathbar__meta">
        <button
          type="button"
          className="pathbar__back"
          title={canGoBack ? 'Back to previous folder' : 'No previous folder'}
          onClick={goBack}
          disabled={!canGoBack}
          aria-label="Back"
        >
          ← back
        </button>
        <button
          type="button"
          className="pathbar__sort"
          title="Change sort"
          onClick={() => dispatch({ type: 'setMode', mode: 'command', buffer: 'sort' })}
        >
          sort: {activeTab?.sortKey}
          {activeTab?.sortReverse ? '↓' : '↑'}
        </button>
        <button
          type="button"
          className="pathbar__view"
          title="Change view"
          onClick={() => dispatch({ type: 'setMode', mode: 'command', buffer: 'view' })}
        >
          {activeTab?.viewMode === 'grid'
            ? '⊞'
            : activeTab?.viewMode === 'preview'
              ? '▣'
              : activeTab?.viewMode === 'tag'
                ? '◐'
                : '☰'}
        </button>
        <button
          type="button"
          className="pathbar__find"
          title="Find (⌘F or /)"
          onClick={() => dispatch({ type: 'setMode', mode: 'command', verb: 'goto' })}
          aria-label="Find"
        >
          <span className="pathbar__find-icon" aria-hidden>⌕</span>
          Find
          <kbd className="pathbar__find-kbd">⌘F</kbd>
        </button>
      </div>
    </div>
  );
}
