import { useMemo } from 'react';
import { useStore } from '../store';
import { basename, dirname, lastCol, visibleEntries } from '../actions';
import type { Entry } from '../types';
import './FolderHeader.css';

/**
 * Editorial header block above the file list.
 *
 * Port of the themes.html .header block:
 *   - Kicker: <parent> · Current folder · Last modified Xh ago
 *   - Folder headline (Fraunces, 58px, opsz 144). Trailing token (e.g. the
 *     year in 'Travel 2026') renders in --accent when the name splits on
 *     whitespace; otherwise the whole name is in ink.
 *   - Italic-serif dek: one-line count summary (refined by fm-cyd).
 *   - Ornament rule with ❦ (shared .ornament class from ornaments.css).
 */
export function FolderHeader() {
  const { state, activeTab } = useStore();

  const view = useMemo(() => {
    if (!activeTab) return null;
    const col = lastCol(activeTab);
    const cwd = activeTab.trail[col];
    const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
    return { cwd, entries };
  }, [activeTab, state.entriesByPath]);

  if (!view) return null;
  const { cwd, entries } = view;

  const name = basename(cwd) || '/';
  const parentName = cwd === '/' ? '' : basename(dirname(cwd)) || '/';
  const [head, tail] = splitTrailingToken(name);
  const mtimeLabel = latestMtimeLabel(entries);
  const countLine = summarize(entries);

  return (
    <header className="folder-header">
      <div className="folder-header__kicker">
        {parentName && (
          <>
            <span className="folder-header__kicker-item">{parentName}</span>
            <span className="folder-header__sep" aria-hidden />
          </>
        )}
        <span className="folder-header__kicker-item">Current folder</span>
        {mtimeLabel && (
          <>
            <span className="folder-header__sep" aria-hidden />
            <span className="folder-header__kicker-item">
              Last modified {mtimeLabel}
            </span>
          </>
        )}
      </div>

      <h1 className="folder-header__title" title={cwd}>
        {head}
        {tail && <span className="folder-header__title-accent">{tail}</span>}
      </h1>

      <p className="folder-header__dek">{countLine}</p>

      <div className="ornament" role="presentation">
        <span className="mark">❦</span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

/** If the folder name ends with a short token (year, version), return
 *  [head, tail] so the tail can render in --accent. Otherwise [name, '']. */
function splitTrailingToken(name: string): [string, string] {
  const trimmed = name.trim();
  if (!trimmed) return ['/', ''];

  // Match a trailing space + non-space token of <=10 chars that contains
  // at least one digit OR is all-caps (e.g. "2026", "v2", "Q4", "GOLD").
  const m = /^(.+?)\s+(\S{1,10})$/.exec(trimmed);
  if (!m) return [trimmed, ''];
  const tail = m[2];
  if (/\d/.test(tail) || /^[A-Z][A-Z0-9-]+$/.test(tail)) {
    return [`${m[1]} `, tail];
  }
  return [trimmed, ''];
}

function latestMtimeLabel(entries: Entry[]): string {
  if (entries.length === 0) return '';
  let latest = 0;
  for (const e of entries) if (e.mtimeMs > latest) latest = e.mtimeMs;
  if (!latest) return '';
  const diff = Date.now() - latest;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
  return new Date(latest).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One-line dek — a light factual summary. Richer type-breakdown copy will
 *  live in fm-cyd (metadata summary line). */
function summarize(entries: Entry[]): string {
  if (entries.length === 0) return 'An empty folder.';
  let dirs = 0;
  let files = 0;
  for (const e of entries) {
    if (e.kind === 'dir') dirs += 1;
    else files += 1;
  }
  const dirPart = dirs === 0 ? '' : `${dirs} ${dirs === 1 ? 'folder' : 'folders'}`;
  const filePart = files === 0 ? '' : `${files} ${files === 1 ? 'file' : 'files'}`;
  if (dirPart && filePart) return `${dirPart}, ${filePart}.`;
  return `${dirPart || filePart}.`;
}
