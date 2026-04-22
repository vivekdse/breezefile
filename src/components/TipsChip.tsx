/*
 * TipsChip — rotating "did you know" hints in the bottom-right corner.
 *
 * Only shows after the Welcome card is dismissed (no point competing for
 * attention with the modal). Dismissing with × hides for the session
 * only — to turn tips off permanently the user runs the `tips` verb.
 *
 * Hidden while the Tutorial is active (body.tutorial-active class —
 * styled in Tutorial.css) so the two surfaces never compete.
 */

import { useEffect, useRef, useState } from 'react';
import { shouldShowWelcome } from './Welcome';
import './TipsChip.css';

const ENABLED_KEY = 'fm.tipsEnabled';
const ROTATE_MS = 9000;

const TIPS: { lead: string; type?: string; tail?: string }[] = [
  { lead: 'To find a folder or file,', type: 'find', tail: 'and press Enter' },
  { lead: 'To switch the color palette, type', type: 'theme' },
  { lead: 'To copy files, type', type: 'copy' },
  { lead: 'To paste at the current folder, type', type: 'ph' },
  { lead: 'To move files, type', type: 'move' },
  { lead: 'To sort the folder, type', type: 'sort' },
  { lead: 'To delete files, type', type: 'delete' },
  { lead: 'To make a new folder, type', type: 'create' },
  { lead: 'Press', type: 'space', tail: 'to mark a file (then type a verb)' },
  { lead: 'Press', type: '⌘F', tail: 'for recursive search' },
  { lead: 'Drag any row out to Slack, Gmail, or Finder' },
  { lead: 'Confirm prompts accept', type: 'Y / N' },
  { lead: 'Arrow Up on the first row goes to the parent folder' },
  { lead: 'To run this walkthrough again, type', type: 'tutorial' },
  { lead: 'To turn these tips off, type', type: 'tips' },
];

export function isTipsEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setTipsEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* noop */
  }
  // Ping any mounted TipsChip so it re-evaluates.
  window.dispatchEvent(new CustomEvent('fm:tipsToggled'));
}

export function TipsChip() {
  // Permanent on/off via the `tips` verb. Default on.
  const [enabled, setEnabled] = useState<boolean>(() => isTipsEnabled());
  // Session dismiss — × hides the chip until the next launch but doesn't
  // touch the persistent enabled flag.
  const [hiddenForSession, setHiddenForSession] = useState(false);
  // Don't show while the Welcome card is up. Watch for its dismissal.
  const [welcomeGone, setWelcomeGone] = useState<boolean>(() => !shouldShowWelcome());
  const [idx, setIdx] = useState<number>(() =>
    Math.floor(Math.random() * TIPS.length),
  );
  const pausedRef = useRef(false);

  // React to enable/disable from the `tips` verb.
  useEffect(() => {
    function onToggle() {
      setEnabled(isTipsEnabled());
      // Re-enabling clears any previous session-dismiss so the tip is
      // visible immediately rather than waiting for a relaunch.
      setHiddenForSession(false);
    }
    window.addEventListener('fm:tipsToggled', onToggle);
    return () => window.removeEventListener('fm:tipsToggled', onToggle);
  }, []);

  // Watch for the Welcome card closing.
  useEffect(() => {
    if (welcomeGone) return;
    function check() {
      if (!shouldShowWelcome()) setWelcomeGone(true);
    }
    window.addEventListener('fm:welcomeDismissed', check);
    // Backup poll in case the event was missed (older Welcome paths).
    const id = window.setInterval(check, 1000);
    return () => {
      window.removeEventListener('fm:welcomeDismissed', check);
      window.clearInterval(id);
    };
  }, [welcomeGone]);

  const visible = enabled && !hiddenForSession && welcomeGone;

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setIdx((i) => (i + 1) % TIPS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible) return null;
  const tip = TIPS[idx];

  return (
    <div
      className="tips-chip"
      role="status"
      aria-label="Tip"
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
    >
      <span className="tips-chip__icon" aria-hidden>
        Tip
      </span>
      <span key={idx} className="tips-chip__text">
        {tip.lead}
        {tip.type && (
          <>
            {' '}
            <kbd className="tips-chip__kbd">{tip.type}</kbd>
          </>
        )}
        {tip.tail && <> {tip.tail}</>}
      </span>
      <button
        type="button"
        className="tips-chip__dismiss"
        onClick={() => setHiddenForSession(true)}
        aria-label="Hide tips for this session"
        title="Hide for this session — type `tips` to toggle"
      >
        ×
      </button>
    </div>
  );
}
