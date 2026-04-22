/*
 * TipsChip — rotating "did you know" hints in the bottom-right corner.
 *
 * For first-time users the verb prompt is invisible until they type. A
 * quiet rotating tip every ~8s nudges them toward the most useful actions
 * without an in-your-face tutorial. Pauses on hover so they can read.
 * Dismissible forever via × (persisted in localStorage).
 */

import { useEffect, useRef, useState } from 'react';
import './TipsChip.css';

const STORAGE_KEY = 'fm.tipsDismissed';
const ROTATE_MS = 9000;

// Each tip explicitly tells the user what to TYPE — first-time users
// don't realize that 'theme' / 'copy' / 'find' are typed words, not
// hover targets. The "Type X" pattern makes the action unmistakable.
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
];

export function TipsChip() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [idx, setIdx] = useState<number>(() =>
    Math.floor(Math.random() * TIPS.length),
  );
  const pausedRef = useRef(false);

  useEffect(() => {
    if (dismissed) return;
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setIdx((i) => (i + 1) % TIPS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [dismissed]);

  if (dismissed) return null;
  const tip = TIPS[idx];

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* noop */
    }
    setDismissed(true);
  }

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
        onClick={dismiss}
        aria-label="Hide tips"
        title="Hide tips"
      >
        ×
      </button>
    </div>
  );
}
