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

/** Coarse file-type buckets — grouped for prose readability, not mime
 *  fidelity. Keep in sync with Preview's classify() if fidelity matters;
 *  here we stay single-pass and allocation-free. */
type Bucket = 'image' | 'document' | 'sheet' | 'film' | 'audio' | 'code' | 'other';

const EXT_TO_BUCKET: Record<string, Bucket> = {
  // images
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', heic: 'image', avif: 'image', svg: 'image',
  // documents
  pdf: 'document', doc: 'document', docx: 'document', rtf: 'document',
  txt: 'document', md: 'document', pages: 'document',
  // sheets
  csv: 'sheet', tsv: 'sheet', xls: 'sheet', xlsx: 'sheet', numbers: 'sheet',
  // film
  mov: 'film', mp4: 'film', m4v: 'film', avi: 'film', mkv: 'film', webm: 'film',
  // audio
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio', aac: 'audio',
  // code
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', py: 'code', rs: 'code',
  go: 'code', rb: 'code', sh: 'code', html: 'code', css: 'code', json: 'code',
  yml: 'code', yaml: 'code', toml: 'code', xml: 'code',
};

const BUCKET_LABEL: Record<Bucket, [string, string]> = {
  image:    ['image',    'images'],
  document: ['document', 'documents'],
  sheet:    ['sheet',    'sheets'],
  film:     ['film',     'films'],
  audio:    ['audio',    'audio files'],
  code:     ['code file','code files'],
  other:    ['other',    'other'],
};

/** One-line dek: "N folders · M files — X images, Y documents, Z films".
 *  Single pass over the already-loaded entries; no recursive stats. */
function summarize(entries: Entry[]): string {
  if (entries.length === 0) return 'An empty folder.';

  let dirs = 0;
  let files = 0;
  const buckets: Record<Bucket, number> = {
    image: 0, document: 0, sheet: 0, film: 0, audio: 0, code: 0, other: 0,
  };

  for (const e of entries) {
    if (e.kind === 'dir') {
      dirs += 1;
      continue;
    }
    files += 1;
    const ext = (e.ext || '').toLowerCase().replace(/^\./, '');
    const bucket = EXT_TO_BUCKET[ext] ?? 'other';
    buckets[bucket] += 1;
  }

  // "3 folders · 7 files" lead.
  const dirPart = dirs === 0 ? '' : `${dirs} ${dirs === 1 ? 'folder' : 'folders'}`;
  const filePart = files === 0 ? '' : `${files} ${files === 1 ? 'file' : 'files'}`;
  const lead = [dirPart, filePart].filter(Boolean).join(' · ');

  if (files === 0) return `${lead}.`;

  // Breakdown — skip empty buckets; present in rough semantic priority.
  const order: Bucket[] = ['image', 'document', 'sheet', 'film', 'audio', 'code', 'other'];
  const parts: string[] = [];
  for (const b of order) {
    const n = buckets[b];
    if (n === 0) continue;
    const [one, many] = BUCKET_LABEL[b];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (parts.length === 0) return `${lead}.`;
  return `${lead} — ${joinNatural(parts)}.`;
}

/** "a, b, and c" / "a and b" / "a". No Oxford comma for tight prose. */
function joinNatural(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
