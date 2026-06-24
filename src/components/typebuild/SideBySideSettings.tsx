// TypeBuild side-by-side layout settings (bead fm-b5at.6).
//
// Rendered inside the Settings "TypeBuild" accordion, below the auth panel.
// Two knobs — Chrome split % and auto-on-task-start — plus a capability-aware
// status line:
//   'ok'            → arranging Chrome works; nothing extra to show.
//   'no-permission' → (mac) needs Accessibility; offer the privacy-pane button.
//   'unsupported'   → (Wayland / no wmctrl) explain degraded mode: we still
//                     snap our own window; the user snaps Chrome by hand.
//
// Prefs are persisted via the self-contained sideBySidePrefs localStorage
// helper (not the core fm-state store), keeping the plugin's settings local.

import { useEffect, useState } from 'react';
import { fm } from '../../bridge';
import { usePlatform } from '../../platform';
import {
  loadSideBySidePrefs,
  saveSideBySidePrefs,
  type SideBySidePrefs,
} from '../../sideBySidePrefs';

type Probe = 'ok' | 'no-permission' | 'unsupported' | 'loading';

export function SideBySideSettings() {
  const { caps } = usePlatform();
  const [prefs, setPrefs] = useState<SideBySidePrefs>(() =>
    loadSideBySidePrefs(),
  );
  const [probe, setProbe] = useState<Probe>('loading');

  // Probe Chrome-arranging capability/permission on open so the status line
  // shows the right affordance.
  useEffect(() => {
    let alive = true;
    void fm.sideBySide
      .probe()
      .then((p) => {
        if (alive) setProbe(p);
      })
      .catch(() => {
        if (alive) setProbe('unsupported');
      });
    return () => {
      alive = false;
    };
  }, []);

  function update(patch: Partial<SideBySidePrefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveSideBySidePrefs(next);
  }

  return (
    <div className="settings__group">
      <div className="settings__row">
        <span className="settings__action">
          <label className="settings__inline-label">
            <input
              type="checkbox"
              checked={prefs.autoOnTaskStart}
              onChange={(e) => update({ autoOnTaskStart: e.target.checked })}
            />
            <span>Auto side-by-side when a TypeBuild task starts</span>
          </label>
        </span>
        <span className="settings__path settings__hint">
          On task start, snap this window to the right and Google Chrome to
          the left so you watch Claude drive the browser while you approve
          here. Restores your window when the session's tab closes.
        </span>
      </div>

      <div className="settings__row">
        <span className="settings__action">
          Chrome (left) width: {prefs.splitPct}%
        </span>
        <input
          type="range"
          min={30}
          max={85}
          step={1}
          value={prefs.splitPct}
          onChange={(e) => update({ splitPct: Number(e.target.value) })}
          aria-label="Chrome split percentage"
        />
      </div>

      {probe === 'no-permission' && (
        <div className="settings__row">
          <span className="settings__path settings__hint">
            To position Chrome, TypeBuild needs Accessibility permission. Until
            then it snaps only its own window — Chrome stays put.
          </span>
          <button
            type="button"
            className="settings__reset"
            onClick={() => void fm.openPrivacyPane()}
          >
            Open Privacy settings
          </button>
        </div>
      )}

      {probe === 'unsupported' && (
        <div className="settings__row">
          <span className="settings__path settings__hint">
            {caps.id === 'linux'
              ? 'Moving other apps’ windows isn’t available in this session (Wayland, or wmctrl/xdotool not installed). Side-by-side still snaps TypeBuild to the right — snap Chrome to the left yourself (or install wmctrl on X11).'
              : 'Positioning Chrome isn’t available here. Side-by-side still snaps TypeBuild to the right; snap Chrome to the left manually.'}
          </span>
        </div>
      )}
    </div>
  );
}
