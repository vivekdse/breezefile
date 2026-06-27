import { useIsMac } from '../platform';
import { Icon } from './Icon';
import { Tabbar } from './Tabbar';
import './Titlebar.css';

export function Titlebar() {
  // The 68px gutter only exists to clear the macOS hidden-inset traffic
  // lights. Windows/Linux use a native window frame, so the gutter is dead
  // space there — drop it (and tag the bar platform-mac for CSS).
  const isMac = useIsMac();
  // task-6d0fd232d6c2 — the permanent Home button open-or-focuses the Home
  // (kind:'home') tab via the same fm:openProjects event App.tsx listens for.
  const goHome = () => window.dispatchEvent(new CustomEvent('fm:openProjects'));
  return (
    <div className={`titlebar drag${isMac ? ' platform-mac' : ''}`}>
      {isMac && <div className="titlebar__traffic" aria-hidden />}
      <div className="titlebar__left">
        <div className="titlebar__brand" aria-label="Type.Build">
          <span className="titlebar__brand-name">Type.Build</span>
        </div>
        <button
          type="button"
          className="titlebar__home"
          onClick={goHome}
          title="Home"
          aria-label="Home"
        >
          <Icon name="home" size={15} />
        </button>
      </div>
      {/* task-6d0fd232d6c2 — tabs ride the titlebar row, right-aligned. The
          Tabbar's own zone:auto margin keeps folder/task zones partitioned. */}
      <div className="titlebar__tabs">
        <Tabbar />
      </div>
    </div>
  );
}
