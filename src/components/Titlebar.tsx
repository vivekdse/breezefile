import './Titlebar.css';

export function Titlebar() {
  return (
    <div className="titlebar drag">
      <div className="titlebar__traffic" aria-hidden />
      <div className="titlebar__title">File Manager</div>
      <div className="titlebar__actions no-drag">
        <button className="titlebar__btn" title="New tab">+</button>
      </div>
    </div>
  );
}
