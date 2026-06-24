import { useIsMac } from '../platform';
import './Titlebar.css';

export function Titlebar() {
  // The 68px gutter only exists to clear the macOS hidden-inset traffic
  // lights. Windows/Linux use a native window frame, so the gutter is dead
  // space there — drop it (and tag the bar platform-mac for CSS).
  const isMac = useIsMac();
  return (
    <div className={`titlebar drag${isMac ? ' platform-mac' : ''}`}>
      {isMac && <div className="titlebar__traffic" aria-hidden />}
      <div className="titlebar__brand" aria-label="TypeBuild — Agentic, Keyboard-First File Manager">
        <span className="titlebar__brand-name">TypeBuild</span>
        <span className="titlebar__brand-tag">Agentic, Keyboard-First File Manager</span>
      </div>
    </div>
  );
}
