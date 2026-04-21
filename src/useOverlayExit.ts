import { useCallback, useState } from 'react';

/**
 * fm-dkv — two-phase overlay dismissal.
 *
 * Overlays are conditionally rendered in App.tsx (`{renaming && <…>}`).
 * Without this hook, closing an overlay sets the parent state to falsy
 * which unmounts the component immediately — no exit animation.
 *
 * Usage:
 *
 *     function RenameOverlay({ onClose }) {
 *       const { exit, state } = useOverlayExit(onClose);
 *       return (
 *         <div className="overlay" data-state={state} onClick={exit}>
 *           <div className="overlay__box">…
 *             <input onKeyDown={(e) => e.key === 'Escape' && exit()} />
 *           </div>
 *         </div>
 *       );
 *     }
 *
 * CSS (in App.css):
 *
 *     .overlay[data-state="leave"] { animation: gpFadeOut var(--motion-exit) forwards; }
 *     .overlay[data-state="leave"] .overlay__box { animation: gpPopOut var(--motion-exit) forwards; }
 *
 * `exit()` flips data-state to "leave", the CSS animations play, and
 * after `exitMs` the real onClose fires — which sets the parent state to
 * falsy and unmounts us. Double-calls are idempotent.
 */
export function useOverlayExit(onClose: () => void, exitMs = 180) {
  const [leaving, setLeaving] = useState(false);

  const exit = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onClose, exitMs);
  }, [leaving, onClose, exitMs]);

  return { exit, state: leaving ? ('leave' as const) : ('enter' as const) };
}
