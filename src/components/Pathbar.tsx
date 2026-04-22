import { useStore } from '../store';
import './Pathbar.css';

type Props = {
  path: string;
  onNavigate: (path: string) => void;
};

export function Pathbar({ path, onNavigate }: Props) {
  const { state, setTab, dispatch, activeTab } = useStore();
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
          {activeTab?.viewMode === 'grid' ? '⊞' : '☰'}
        </button>
      </div>
      <div className="pathbar__search">
        <button
          type="button"
          className="pathbar__search-icon"
          title="Find (recursive in this folder)"
          onClick={() => dispatch({ type: 'setMode', mode: 'command', buffer: 'find' })}
          aria-label="Find"
        >
          ⌕
        </button>
        <input
          className="pathbar__search-input"
          type="text"
          placeholder="Filter (Esc to clear)…"
          spellCheck={false}
          value={activeTab?.filter ?? ''}
          onChange={(e) => setTab({ filter: e.target.value })}
          onFocus={() => dispatch({ type: 'setMode', mode: 'find' })}
          onBlur={() =>
            state.mode === 'find' && dispatch({ type: 'setMode', mode: 'normal' })
          }
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTab({ filter: '' });
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
    </div>
  );
}
