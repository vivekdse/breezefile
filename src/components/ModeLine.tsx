import { useStore } from '../store';
import './ModeLine.css';

export function ModeLine() {
  const { state } = useStore();
  if (!state.pending && !state.statusMsg) return null;

  return (
    <div className="modeline">
      {state.pending && <span className="modeline__pending">{state.pending}</span>}
      {state.statusMsg && <span className="modeline__status">{state.statusMsg}</span>}
    </div>
  );
}
