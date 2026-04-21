import { useStore } from '../store';
import { basename } from '../actions';
import './Tabbar.css';

export function Tabbar() {
  const { state, dispatch } = useStore();
  if (state.tabs.length <= 1) return null;

  return (
    <div className="tabbar">
      {state.tabs.map((t, i) => {
        const cwd = t.trail[t.trail.length - 1];
        const label = basename(cwd) || '/';
        const active = i === state.activeTab;
        return (
          <button
            key={t.id}
            className={`tabbar__tab ${active ? 'tabbar__tab--active' : ''}`}
            onClick={() => dispatch({ type: 'selectTab', index: i })}
          >
            <span className="tabbar__num">{i + 1}</span>
            <span className="tabbar__label">{label}</span>
            <span
              className="tabbar__close"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'closeTab', index: i });
              }}
            >
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}
