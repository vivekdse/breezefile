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
        <span className="pathbar__sort">
          sort: {activeTab?.sortKey}
          {activeTab?.sortReverse ? '↓' : '↑'}
        </span>
        <span className="pathbar__view">
          {activeTab?.viewMode === 'grid' ? '⊞' : '☰'}
        </span>
      </div>
      <div className="pathbar__search">
        <span className="pathbar__search-icon" aria-hidden>
          ⌕
        </span>
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
