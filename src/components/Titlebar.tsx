import './Titlebar.css';
import { useIsMac } from '../platform';

export function Titlebar() {
  // The 68px gutter only exists to clear the macOS hidden-inset traffic
  // lights. Windows/Linux use a native window frame, so the gutter is dead
  // space there — drop it.
  const isMac = useIsMac();
  return (
    <div className="titlebar drag">
      {isMac && <div className="titlebar__traffic" aria-hidden />}
      <div className="titlebar__brand" aria-label="Breeze File — Agentic, Keyboard-First File Manager">
        <span className="titlebar__brand-name">Breeze<em>·</em>File</span>
        <span className="titlebar__brand-tag">Agentic, Keyboard-First File Manager</span>
      </div>
    </div>
  );
}
