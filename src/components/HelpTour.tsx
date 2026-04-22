/*
 * HelpTour — 5-slide carousel that re-introduces the verb system.
 *
 * Welcome (fm-3ck) is one dense card shown on first run; HelpTour is the
 * slower walkthrough — one concept per slide, advanced with ← / → or
 * Enter. Opened on demand by the 'help' verb (fm-8pu), not shown
 * automatically. We want the answer to "how do I use this?" to always
 * be a short, readable tour, not a wall of text.
 */

import { useEffect, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import './HelpTour.css';

type Slide = {
  glyph: string;
  title: string;
  body: React.ReactNode;
};

const SLIDES: Slide[] = [
  {
    glyph: '✦',
    title: 'Type to act',
    body: (
      <>
        Breeze File is driven by verbs. Start typing from anywhere —{' '}
        <kbd>copy</kbd>, <kbd>move</kbd>, <kbd>sort</kbd>, <kbd>find</kbd>,{' '}
        <kbd>theme</kbd> — the chip prompt fills in the rest.
      </>
    ),
  },
  {
    glyph: '☐',
    title: 'Space selects',
    body: (
      <>
        <kbd>space</kbd> toggles selection on the highlighted row.{' '}
        <kbd>shift + space</kbd> selects everything in the folder. Selected
        rows get a filled checkbox.
      </>
    ),
  },
  {
    glyph: '↘',
    title: 'Copy / Move, then navigate',
    body: (
      <>
        Pick <kbd>copy</kbd> or <kbd>move</kbd>; a floating chip follows you.
        Drill to the destination folder, then type <kbd>ph</kbd> (paste here)
        or click the chip. Nothing moves until you confirm.
      </>
    ),
  },
  {
    glyph: '⌕',
    title: 'Find with priority',
    body: (
      <>
        <kbd>⌘F</kbd> or <kbd>/</kbd> opens recursive find. Current folder
        and subfolders rank first, then recents, bookmarks, and Spotlight.
      </>
    ),
  },
  {
    glyph: '↗',
    title: 'Drag out to anything',
    body: (
      <>
        Drag any row — or the selection — out to Slack, Gmail, a browser
        upload field, Finder. That's the one thing ranger can't do on
        macOS, and the reason this app exists.
      </>
    ),
  },
];

export function HelpTour({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);
  const [i, setI] = useState(0);

  const isLast = i === SLIDES.length - 1;

  function next() {
    if (isLast) exit();
    else setI((n) => Math.min(SLIDES.length - 1, n + 1));
  }
  function prev() {
    setI((n) => Math.max(0, n - 1));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const slide = SLIDES[i];

  return (
    <div className="overlay help-overlay" data-state={state} onClick={exit}>
      <div
        className="help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="help__close"
          onClick={exit}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>

        <div className="help__eyebrow">
          How it works · {i + 1} of {SLIDES.length}
        </div>

        <div className="help__glyph" aria-hidden>
          {slide.glyph}
        </div>
        <h1 id="help-title" className="help__title">
          {slide.title}
        </h1>
        <p className="help__body">{slide.body}</p>

        <div className="help__dots" role="tablist" aria-label="Slide">
          {SLIDES.map((_, idx) => (
            <button
              key={idx}
              type="button"
              role="tab"
              aria-selected={idx === i}
              aria-label={`Slide ${idx + 1}`}
              className={'help__dot' + (idx === i ? ' help__dot--on' : '')}
              onClick={() => setI(idx)}
            />
          ))}
        </div>

        <div className="help__footer">
          <button
            type="button"
            className="help__btn help__btn--ghost"
            onClick={prev}
            disabled={i === 0}
          >
            ← Back
          </button>
          <button
            type="button"
            className="help__btn"
            onClick={next}
            autoFocus
          >
            {isLast ? 'Done' : 'Next →'}
            <kbd className="help__btn-kbd">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
