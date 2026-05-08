import './Titlebar.css';

export function Titlebar() {
  return (
    <div className="titlebar drag">
      <div className="titlebar__traffic" aria-hidden />
      <div className="titlebar__brand" aria-label="Breeze File — Agentic, Keyboard-First File Manager">
        <span className="titlebar__brand-name">Breeze<em>·</em>File</span>
        <span className="titlebar__brand-tag">Agentic, Keyboard-First File Manager</span>
      </div>
    </div>
  );
}
