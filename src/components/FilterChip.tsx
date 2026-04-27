import { useStore } from '../store';
import './FilterChip.css';

// Active text-filter pill. Renders just above the file list whenever the
// active tab has a substring filter set (via `goto` file pick or `zf`).
// Click ✕ or press Esc to clear — both routes set tab.filter to ''.
export function FilterChip() {
  const { activeTab, setTab } = useStore();
  const filter = activeTab?.filter ?? '';
  if (!filter) return null;
  return (
    <div className="filter-chip" role="status" aria-live="polite">
      <span className="filter-chip__label">Filter</span>
      <span className="filter-chip__value">“{filter}”</span>
      <button
        type="button"
        className="filter-chip__clear"
        aria-label="Clear filter"
        title="Clear filter (Esc)"
        onClick={() => setTab({ filter: '' })}
      >
        ✕
      </button>
    </div>
  );
}
