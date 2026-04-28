/*
 * HelpTour — slide-based help. Click "Help" in the status bar or run
 * the `:help` verb. Three sections, eight slides:
 *
 *   1) value — why this app exists
 *   2) verbs — how the type-to-act model works
 *   3) catalog — what verbs / chords exist (grouped)
 *
 * MAINTENANCE: every time we add a new feature or verb, this file gets
 * an update. The catalog slides drive directly off the CATALOG constant
 * below — add a row there and the slide picks it up. See CLAUDE.md.
 */

import { useEffect, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { fm } from '../bridge';
import './HelpTour.css';

declare const __APP_VERSION__: string;

function cmpVersion(a: string, b: string): number {
  const norm = (v: string) =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const da = A[i] ?? 0;
    const db = B[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

type VerbItem = { name: string; chord?: string; what: string };
type CatalogSlide = {
  kind: 'catalog';
  glyph: string;
  title: string;
  lede: string;
  verbs: VerbItem[];
};
type NarrativeSlide = {
  kind: 'narrative';
  glyph: string;
  title: string;
  body: React.ReactNode;
};
type Slide = CatalogSlide | NarrativeSlide;

const SLIDES: Slide[] = [
  {
    kind: 'narrative',
    glyph: '✦',
    title: 'Find files. Move them. Send them.',
    body: (
      <>
        Get anywhere in your files by typing. Then drag any file straight into
        a Slack message, a Gmail draft, or a web upload field —{' '}
        <b>no saving, no re-uploading</b>.
      </>
    ),
  },
  {
    kind: 'narrative',
    glyph: '⌘',
    title: 'Type the action you want.',
    body: (
      <>
        Type <kbd>copy</kbd>, <kbd>move</kbd>, <kbd>tag</kbd>, or{' '}
        <kbd>share</kbd>. A small panel shows your choices. Pick one, hit{' '}
        <kbd>↵</kbd>. Every action works the same way — nothing to memorize.
      </>
    ),
  },
  {
    kind: 'catalog',
    glyph: '↕',
    title: 'Navigate & find',
    lede: 'Move the cursor; jump anywhere; search across folders.',
    verbs: [
      { name: 'cursor', chord: 'h j k l', what: 'left / down / up / right (or arrows)' },
      { name: 'open / parent', chord: '↵ / ⌫', what: 'enter folder / go up' },
      { name: 'top / bottom', chord: 'gg / G', what: 'first or last row' },
      { name: 'history', chord: 'H / L', what: 'back / forward' },
      { name: 'find', chord: '⌘F or /', what: 'recursive search across folders + Spotlight' },
      { name: 'go to / find', what: 'type a folder OR file name in the chip prompt — file picks jump to its parent folder filtered to your query (Esc or ✕ to clear)' },
      { name: 'goto home', chord: 'gh', what: 'jump to ~ (also g/, ge, gu, gd, gp…)' },
      { name: 'quick find', chord: 'f', what: 'jump to a row by typed prefix' },
    ],
  },
  {
    kind: 'catalog',
    glyph: '☐',
    title: 'Select & manage files',
    lede: 'Mark with space, then act. Or run a verb directly on the cursor row.',
    verbs: [
      { name: 'mark / all', chord: 'space / ⇧space', what: 'toggle one / select every visible row' },
      { name: 'select', what: 'smart filters: images, videos, by extension, folders only…' },
      { name: 'copy / move', what: 'stage files; floating chip follows you to the destination' },
      { name: 'paste here', chord: 'ph', what: 'commit the staged copy/move (po, pl, phl variants)' },
      { name: 'rename', chord: 'cw / a / A / I', what: 'whole / before-ext / append / prepend' },
      { name: 'trash / delete', chord: 'dD / dF', what: 'send to Trash / permanent delete' },
      { name: 'create', chord: 'F7 or :touch', what: 'new folder / new file' },
      { name: 'duplicate', what: 'right-click → Duplicate' },
    ],
  },
  {
    kind: 'catalog',
    glyph: '↗',
    title: 'Open, share, drag out',
    lede: 'The drag-out is the whole reason this app exists.',
    verbs: [
      { name: 'open', chord: '↵', what: 'open with default app' },
      { name: 'open with…', what: 'pick an app; optionally bind it as default for that extension' },
      { name: 'drag out', chord: 'd or drag', what: 'drag any row (or selection) to Slack, Gmail, Finder, anywhere' },
      { name: 'share', what: 'native macOS share sheet (Mail, Messages, AirDrop, …)' },
      { name: 'copy path', chord: 'yy / yn / yd', what: 'full path / name / parent dir to clipboard' },
      { name: 'reveal', chord: 'R', what: 'reveal in Finder' },
      { name: 'open terminal', what: 'launch your default terminal in this folder' },
    ],
  },
  {
    kind: 'catalog',
    glyph: '▦',
    title: 'View & sort',
    lede: 'Switch how the folder reads, sort by anything, change the look.',
    verbs: [
      { name: 'view', chord: 'wl / wg / wp / wt', what: 'list / grid / preview / tag' },
      { name: 'sort', chord: 'on / os / om / oc / ot / oe', what: 'name / size / mtime / ctime / type / ext (caps for desc, or for reverse)' },
      { name: 'hidden', chord: 'zh', what: 'show / hide dotfiles' },
      { name: 'theme', chord: 'zT', what: 'cycle dark/light; or :theme for the full picker' },
    ],
  },
  {
    kind: 'catalog',
    glyph: '◐',
    title: 'Tags — color, group, filter',
    lede: 'Press wt to enter Tag view. Tags are rules over file metadata.',
    verbs: [
      { name: 'tag view', chord: 'wt', what: 'replaces preview with the tag inspector' },
      { name: 'apply HUD', chord: 't', what: 'in tag view: type to find a tag, ↵ to add or remove on the whole folder' },
      { name: 'newtag', what: 'create a tag with a rule (extension / size / modified / name) or manual-only' },
      { name: 'tag / untag', what: 'add or remove a tag from every file in this folder (verb form)' },
      { name: 'filter', what: 'narrow the folder to files carrying selected tags · Match all / Match any' },
      { name: 'access keys', what: 'each tag gets a single letter (r=Recent, l=Large, i=Images…) shown in the inspector' },
    ],
  },
  {
    kind: 'catalog',
    glyph: '⊞',
    title: 'Tabs, bookmarks, the rest',
    lede: 'Live across many folders at once; mark places to return to.',
    verbs: [
      { name: 'new tab', chord: 'gn', what: 'open current folder in a new tab' },
      { name: 'switch / close', chord: 'gt / gT / gw', what: 'next / prev / close · ga restores last closed' },
      { name: 'bookmark', chord: 'm<k> / \'<k>', what: 'set / jump (m a then \'a)' },
      { name: 'pin', what: 'pin a folder to the sidebar Favorites' },
      { name: 'shell', chord: '! / s', what: 'run a one-off command in this folder' },
      { name: 'term', what: 'open an embedded terminal pane rooted at this folder · :term-close to dismiss' },
      { name: 'claude / codex / gemini', what: 'open the terminal pane and launch the AI CLI · backgrounded tabs pulse when waiting for input · dock badge + system notification when Breeze is in the background (toggles in Settings → Notifications)' },
      { name: 'open-terminal', chord: 'cli', what: 'open an external terminal app (iTerm, Warp, …) at this folder' },
      { name: 'compress / extract', what: 'zip a selection · expand an archive' },
      { name: 'settings', chord: '?', what: 'view & rebind keys' },
      { name: 'permissions', what: 'see which protected folders Breeze can read; grant any still missing' },
      { name: 'upgrade', what: ':upgrade runs brew upgrade --cask breezefile and relaunches' },
    ],
  },
];

export function HelpTour({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);
  const [i, setI] = useState(0);
  const [pendingUpdate, setPendingUpdate] = useState<{ tag: string } | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  const isLast = i === SLIDES.length - 1;

  // Second-chance nudge: if a newer release exists on GitHub, surface it
  // at the top of the help dialog. UpdateChip also shows this, but users
  // who dismissed it (or haven't seen it yet) land here when they open
  // Help — a natural place to discover the :upgrade verb too.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fm.checkUpdate();
        if (cancelled || !r) return;
        if (cmpVersion(r.version, __APP_VERSION__) > 0) {
          setPendingUpdate({ tag: r.tag });
        }
      } catch {
        /* network blip — no banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function runUpgrade() {
    if (upgrading) return;
    setUpgrading(true);
    void fm.upgrade();
  }

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

        {pendingUpdate && (
          <div className="help__update" role="status">
            <span className="help__update-icon" aria-hidden>↑</span>
            <span className="help__update-text">
              Update <b>{pendingUpdate.tag}</b> available
            </span>
            <button
              type="button"
              className="help__update-btn"
              onClick={runUpgrade}
              disabled={upgrading}
            >
              {upgrading ? 'Upgrading…' : 'Update now'}
            </button>
          </div>
        )}

        <div className="help__eyebrow">
          Help · {i + 1} of {SLIDES.length}
        </div>

        <div className="help__glyph" aria-hidden>
          {slide.glyph}
        </div>
        <h1 id="help-title" className="help__title">
          {slide.title}
        </h1>

        {slide.kind === 'narrative' ? (
          <p className="help__body">{slide.body}</p>
        ) : (
          <>
            <p className="help__lede">{slide.lede}</p>
            <ul className="help__verbs">
              {slide.verbs.map((v) => (
                <li key={v.name + (v.chord ?? '')} className="help__verb">
                  <span className="help__verb-name">{v.name}</span>
                  {v.chord && <kbd className="help__verb-chord">{v.chord}</kbd>}
                  <span className="help__verb-what">{v.what}</span>
                </li>
              ))}
            </ul>
          </>
        )}

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
