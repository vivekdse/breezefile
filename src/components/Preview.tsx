import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { currentEntry, lastCol, visibleEntries } from '../actions';
import { fm } from '../bridge';
import type { Entry } from '../types';
import { Icon, type IconName } from './Icon';
import { OpenWithDialog } from './OpenWithDialog';
import './Preview.css';

/**
 * Preview pane — port of themes.html `.preview` (photo plate → kind label →
 * Fraunces title → mini-rule → dl metadata → tags → actions).
 *
 * Lives in the `preview` grid slot reserved by the shell (App.tsx). Reads
 * the selected entry from the active tab; renders image thumbnails via the
 * existing `fm.thumb` IPC (same pipeline FileGrid uses). For non-image
 * kinds we render a typed-icon placeholder at the same aspect so the pane
 * doesn't jump between selections.
 */
export function Preview() {
  const { state, activeTab } = useStore();

  const selected = useMemo<Entry | undefined>(() => {
    if (!activeTab) return undefined;
    const col = lastCol(activeTab);
    const cwd = activeTab.trail[col];
    const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
    return currentEntry(activeTab, entries);
  }, [activeTab, state.entriesByPath]);

  if (!selected) {
    return (
      <section className="preview preview--empty" aria-label="Preview">
        <div className="preview__empty-mark">❦</div>
        <div className="preview__empty-text">No selection</div>
      </section>
    );
  }

  return <PreviewBody entry={selected} tag={state.tags[selected.path]} />;
}

// ---------------------------------------------------------------------------

interface PreviewBodyProps {
  entry: Entry;
  tag?: string;
}

function PreviewBody({ entry, tag }: PreviewBodyProps) {
  const kind = classify(entry);
  const [imgFailed, setImgFailed] = useState(false);
  const [text, setText] = useState<
    { content: string; truncated: boolean; error?: string } | null
  >(null);
  // When the user picks an app from the native dialog, we show our own
  // confirm modal so they can opt into a persistent binding. Null when
  // no picker is active.
  const [pickedApp, setPickedApp] = useState<string | null>(null);

  async function handleOpenWith() {
    const picked = await fm.pickApplication();
    if (picked) setPickedApp(picked);
  }

  // Reset failure flag when selection changes — otherwise a previous
  // broken image would hide a perfectly good successor.
  useEffect(() => {
    setImgFailed(false);
  }, [entry.path, entry.mtimeMs]);

  // Load a short prefix of text-like files (max ~40KB) for inline preview.
  // Debounce: rapid arrow-key navigation causes a selection storm; without
  // debouncing every intermediate row fires an IPC read, the queue backs
  // up, and cursor movement feels sluggish. 150 ms is long enough to skip
  // nearly all intermediate reads and short enough to feel instant when
  // the user stops on a file.
  useEffect(() => {
    if (kind !== 'text' && kind !== 'sheet') {
      setText(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      fm.readTextFile(entry.path, 40 * 1024)
        .then((r) => {
          if (!cancelled) setText(r);
        })
        .catch((err) => {
          if (!cancelled) setText({ content: '', truncated: false, error: String(err) });
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [entry.path, entry.mtimeMs, kind]);

  const isFav = tag === '*' || tag === 'f';
  const showImage = kind === 'image' && !imgFailed;
  const showText = kind === 'text' || kind === 'sheet';

  return (
    <section className="preview" aria-label="Preview">
      {/* Plate — actual image, text excerpt, or typed-icon fallback.
          Images load directly via file:// so SVG / large photos render at
          full fidelity (CSP already allows img-src file:). Text-like files
          show their first ~40KB in a mono excerpt so you don't have to
          open them to peek at contents. Binary / unsupported kinds keep
          the typed-icon placeholder so the pane doesn't jump size. */}
      <div className="preview__plate">
        {showImage ? (
          <img
            src={fm.fileUrl(entry.path)}
            alt=""
            className="preview__img"
            onError={() => setImgFailed(true)}
          />
        ) : showText ? (
          <div className="preview__text" aria-label={`${kind} file excerpt`}>
            {text === null ? (
              <div className="preview__text-empty">Loading…</div>
            ) : text.error ? (
              <div className="preview__text-empty">Couldn't read file</div>
            ) : (
              <>
                <pre className="preview__text-pre">{text.content}</pre>
                {text.truncated && (
                  <div className="preview__text-trunc">
                    Showing first 40 KB · file is larger
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div
            className={`preview__placeholder preview__placeholder--${kind}`}
            aria-label={`${kind} file`}
          >
            <Icon name={placeholderIcon(kind)} size={72} />
          </div>
        )}
        <div className="preview__cap">{captionFor(entry)}</div>
      </div>

      {/* Kind eyebrow + Fraunces title */}
      <div className="preview__kind">
        {KIND_LABEL[kind]}
        {entry.ext ? ` · ${entry.ext.toUpperCase().replace(/^\./, '')}` : ''}
      </div>
      <h2 className="preview__title">{entry.name}</h2>

      <div className="mini-rule">
        <span>❦</span>
      </div>

      {/* Metadata dl */}
      <dl className="preview__dl">
        <Row k="Size" v={formatSize(entry.size)} />
        {entry.kind !== 'dir' && entry.ext && <Row k="Ext" v={entry.ext} />}
        <Row k="Modified" v={formatRelative(entry.mtimeMs)} />
        <Row k="Created" v={formatRelative(entry.ctimeMs)} />
        <Row k="Where" v={collapseHome(dirname(entry.path))} />
      </dl>

      {/* Tag pill (single tag char per v1 store shape) */}
      {tag && (
        <div className="preview__tags">
          {isFav ? (
            <span className="preview__tag preview__tag--fav">
              <span className="preview__tag-dot" />
              favorite
            </span>
          ) : (
            <span className="preview__tag">
              <span
                className="preview__tag-dot"
                style={{ background: 'var(--hero-tint)' }}
              />
              {`tag · ${tag}`}
            </span>
          )}
        </div>
      )}

      {/* Action row — Open (default/bound app) + Open With… (picker).
          Reveal in Finder survives as a subdued link below so power
          users keep the affordance they had before. */}
      <div className="preview__actions">
        <button
          type="button"
          className="preview__btn preview__btn--primary"
          onClick={() => fm.clipboardWrite(entry.path)}
          title="Copy file path to clipboard"
        >
          <Icon name="drag" size={14} />
          Copy path
        </button>
        <button
          type="button"
          className="preview__btn"
          onClick={() => fm.open(entry.path)}
          title="Open with the default (or bound) application"
        >
          <Icon name="open" size={14} />
          Open
        </button>
        <button
          type="button"
          className="preview__btn"
          onClick={handleOpenWith}
          title="Choose an application to open this file"
        >
          Open With…
        </button>
      </div>
      <div className="preview__sub-actions">
        <button
          type="button"
          className="preview__link"
          onClick={() => fm.reveal(entry.path)}
          title="Reveal in Finder"
        >
          Reveal in Finder
        </button>
      </div>

      {pickedApp && (
        <OpenWithDialog
          filePath={entry.path}
          ext={entry.ext}
          appPath={pickedApp}
          onClose={() => setPickedApp(null)}
        />
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="preview__dl-row">
      <span className="preview__dl-k">{k}</span>
      <span className="preview__dl-v">{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Classification + formatting helpers

type Kind = 'image' | 'film' | 'audio' | 'text' | 'sheet' | 'dir' | 'binary';

const KIND_LABEL: Record<Kind, string> = {
  image: 'Image',
  film: 'Video',
  audio: 'Audio',
  text: 'Document',
  sheet: 'Sheet',
  dir: 'Folder',
  binary: 'File',
};

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg', 'ico',
]);
const FILM_EXT = new Set(['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac']);
const SHEET_EXT = new Set(['csv', 'tsv', 'xlsx', 'xls', 'numbers']);
const TEXT_EXT = new Set([
  'md', 'txt', 'log', 'json', 'yml', 'yaml', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'rb', 'sh', 'zsh', 'bash', 'html', 'css', 'scss', 'xml', 'toml',
  'conf', 'ini', 'env',
]);

function classify(e: Entry): Kind {
  if (e.kind === 'dir') return 'dir';
  // entry.ext from the bridge has no leading dot (e.g. "jpg"); normalize
  // defensively in case a caller passes ".jpg".
  const ext = (e.ext || '').toLowerCase().replace(/^\./, '');
  if (IMAGE_EXT.has(ext)) return 'image';
  if (FILM_EXT.has(ext)) return 'film';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

function placeholderIcon(kind: Kind): IconName {
  switch (kind) {
    case 'image': return 'image';
    case 'film':  return 'film';
    case 'audio': return 'music';
    case 'sheet': return 'sheet';
    case 'text':  return 'text';
    case 'dir':   return 'folder';
    default:      return 'docs';
  }
}

function formatSize(bytes: number): string {
  if (!isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatRelative(ms: number): string {
  if (!ms) return '—';
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  });
}

function captionFor(e: Entry): string {
  if (e.kind === 'dir') return e.path;
  const when = new Date(e.mtimeMs);
  const stamp = when.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `${e.name} · ${stamp}`;
}

function dirname(p: string): string {
  if (p === '/' || p === '') return '/';
  const stripped = p.replace(/\/+$/, '');
  const idx = stripped.lastIndexOf('/');
  if (idx <= 0) return '/';
  return stripped.slice(0, idx);
}

function collapseHome(p: string): string {
  // Best-effort home collapse — the renderer doesn't know HOME directly, so
  // we heuristically match `/Users/<anything>/` and replace with `~/`.
  return p.replace(/^\/Users\/[^/]+\//, '~/');
}
