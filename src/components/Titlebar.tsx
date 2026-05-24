import { useIsMac } from '../platform';
import './Titlebar.css';

export function Titlebar() {
  const isMac = useIsMac();
  return (
    <div className={`titlebar drag${isMac ? ' platform-mac' : ''}`}>
      <div className="titlebar__traffic" aria-hidden />
      <div className="titlebar__brand" aria-label="Breeze File — Agentic, Keyboard-First File Manager">
        <span className="titlebar__brand-name">Breeze<em>·</em>File</span>
        <span className="titlebar__brand-tag">Agentic, Keyboard-First File Manager</span>
      </div>
    </div>
  );
}
