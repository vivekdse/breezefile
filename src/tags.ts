import type { CustomTag, CustomTagCriterion, Entry, TagPaths } from './types';

/**
 * A tag is either a hardcoded SEED rule (predicate over metadata) or a
 * user-created CustomTag (manual-only v1). Both share this unified shape;
 * the renderer doesn't need to know the difference. A tag matches an entry
 * when its predicate fires OR the entry's path is in tagPaths[tag.id].
 */
export type TagDef = {
  id: string;
  name: string;
  color: string;
  description?: string;
  predicate?: (e: Entry) => boolean;
  /** Distinguishes seed (built-in) tags from user-created ones in the UI. */
  builtin?: boolean;
  /** Single-letter access key for the keyboard picker (fm-60k). */
  key?: string;
};

const ext = (e: Entry) => (e.ext ?? '').toLowerCase().replace(/^\./, '');
const dayMs = 86_400_000;

export const SEED_TAGS: TagDef[] = [
  {
    id: 'recent',
    name: 'Recent',
    color: '#a3391a',
    description: 'Modified in the last 3 days',
    predicate: (e) => Date.now() - e.mtimeMs < 3 * dayMs,
    builtin: true,
    key: 'r',
  },
  {
    id: 'large',
    name: 'Large',
    color: '#c99a3e',
    description: 'Files larger than 4 MB',
    predicate: (e) => e.kind !== 'dir' && e.size > 4 * 1024 * 1024,
    builtin: true,
    key: 'l',
  },
  {
    id: 'images',
    name: 'Images',
    color: '#7a3ea1',
    description: 'png · jpg · gif · webp · heic · svg',
    predicate: (e) => /^(png|jpe?g|gif|webp|heic|bmp|svg|ico|avif|tiff?)$/.test(ext(e)),
    builtin: true,
    key: 'i',
  },
  {
    id: 'videos',
    name: 'Videos',
    color: '#6c8a5b',
    description: 'mov · mp4 · mkv · webm · avi',
    predicate: (e) => /^(mov|mp4|m4v|avi|mkv|webm)$/.test(ext(e)),
    builtin: true,
    key: 'v',
  },
  {
    id: 'docs',
    name: 'Documents',
    color: '#3b6ea5',
    description: 'md · txt · pdf · doc · csv',
    predicate: (e) => /^(md|txt|pdf|docx?|csv|rtf|odt)$/.test(ext(e)),
    builtin: true,
    key: 'd',
  },
  {
    id: 'code',
    name: 'Code',
    color: '#2f8f7e',
    description: 'Source files',
    predicate: (e) => /^(ts|tsx|js|jsx|py|go|rs|rb|sh|java|c|cpp|h|swift|kt)$/.test(ext(e)),
    builtin: true,
    key: 'c',
  },
  {
    id: 'archives',
    name: 'Archives',
    color: '#8a6d3b',
    description: 'zip · tar · gz · 7z',
    predicate: (e) => /^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(ext(e)),
    builtin: true,
    key: 'a',
  },
  {
    id: 'stale',
    name: 'Stale',
    color: '#857c6b',
    description: 'Untouched for 180+ days',
    predicate: (e) => Date.now() - e.mtimeMs > 180 * dayMs,
    builtin: true,
    key: 's',
  },
];

/** Reserved by seed tags — auto-assignment for custom tags skips these. */
export const RESERVED_KEYS = new Set(SEED_TAGS.map((t) => t.key!).filter(Boolean));

/** Curated palette offered when the user creates a tag. Picked to read on
 *  paper-theme backgrounds without overpowering the row. */
export const TAG_PALETTE: { id: string; name: string; color: string }[] = [
  { id: 'crimson', name: 'Crimson', color: '#a3391a' },
  { id: 'amber', name: 'Amber', color: '#c99a3e' },
  { id: 'olive', name: 'Olive', color: '#6c8a5b' },
  { id: 'teal', name: 'Teal', color: '#2f8f7e' },
  { id: 'indigo', name: 'Indigo', color: '#3b6ea5' },
  { id: 'plum', name: 'Plum', color: '#7a3ea1' },
  { id: 'rose', name: 'Rose', color: '#c2547a' },
  { id: 'sand', name: 'Sand', color: '#8a6d3b' },
  { id: 'slate', name: 'Slate', color: '#5a6470' },
];

export function evaluateCriterion(crit: CustomTagCriterion, e: Entry): boolean {
  switch (crit.field) {
    case 'extIn':
      return crit.values.some((v) => v.toLowerCase() === ext(e));
    case 'sizeOver':
      return e.kind !== 'dir' && e.size > crit.mb * 1024 * 1024;
    case 'sizeUnder':
      return e.kind !== 'dir' && e.size < crit.mb * 1024 * 1024;
    case 'modifiedWithin':
      return Date.now() - e.mtimeMs < crit.days * dayMs;
    case 'modifiedBefore':
      return Date.now() - e.mtimeMs > crit.days * dayMs;
    case 'nameContains':
      return e.name.toLowerCase().includes(crit.text.toLowerCase());
    case 'nameMatches':
      try {
        return new RegExp(crit.pattern, 'i').test(e.name);
      } catch {
        return false;
      }
    case 'kindIs':
      return crit.value === 'dir' ? e.kind === 'dir' : e.kind !== 'dir';
  }
}

export function criterionToText(crit: CustomTagCriterion | undefined): string {
  if (!crit) return 'Manual — apply with the “tag” verb';
  switch (crit.field) {
    case 'extIn':
      return crit.values.length === 0
        ? 'Extension: (none)'
        : `Extension is ${crit.values.map((v) => '.' + v).join(' · ')}`;
    case 'sizeOver':
      return `Size larger than ${crit.mb} MB`;
    case 'sizeUnder':
      return `Size smaller than ${crit.mb} MB`;
    case 'modifiedWithin':
      return `Modified within last ${crit.days} day${crit.days === 1 ? '' : 's'}`;
    case 'modifiedBefore':
      return `Modified more than ${crit.days} day${crit.days === 1 ? '' : 's'} ago`;
    case 'nameContains':
      return `Name contains “${crit.text}”`;
    case 'nameMatches':
      return `Name matches /${crit.pattern}/i`;
    case 'kindIs':
      return crit.value === 'dir' ? 'Is a folder' : 'Is a file';
  }
}

function customToTagDef(c: CustomTag): TagDef {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    description: c.description ?? criterionToText(c.criterion),
    predicate: c.criterion ? (e) => evaluateCriterion(c.criterion!, e) : undefined,
    builtin: false,
    key: c.key,
  };
}

/** Pick a single-letter key for a new custom tag. Prefers letters from
 *  the tag's own name (skipping vowels-after-first to spread consonants),
 *  falls back to a-z then 0-9. Returns '' if everything is taken. */
export function assignTagKey(name: string, takenKeys: Set<string>): string {
  const taken = new Set([...takenKeys, ...RESERVED_KEYS]);
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const ch of norm) {
    if (!taken.has(ch)) return ch;
  }
  for (const ch of 'bcdefghijklmnopqrstuvwxyz0123456789'.split('')) {
    if (!taken.has(ch)) return ch;
  }
  return '';
}

export function getAllTags(custom: CustomTag[]): TagDef[] {
  return [...SEED_TAGS, ...custom.map(customToTagDef)];
}

export function findTag(id: string, custom: CustomTag[]): TagDef | undefined {
  return getAllTags(custom).find((t) => t.id === id);
}

export function tagMatchesEntry(tag: TagDef, e: Entry, manual: string[] | undefined): boolean {
  if (tag.predicate?.(e)) return true;
  if (manual && manual.includes(e.path)) return true;
  return false;
}

export function tagsForEntry(
  e: Entry,
  activeIds: string[],
  custom: CustomTag[],
  paths: TagPaths,
): TagDef[] {
  const all = getAllTags(custom);
  const out: TagDef[] = [];
  for (const id of activeIds) {
    const tag = all.find((t) => t.id === id);
    if (tag && tagMatchesEntry(tag, e, paths[id])) out.push(tag);
  }
  return out;
}

export function entryMatchesFilter(
  e: Entry,
  filter: { mode: 'off' | 'all' | 'any'; ids: string[] } | undefined,
  custom: CustomTag[],
  paths: TagPaths,
): boolean {
  if (!filter || filter.mode === 'off' || filter.ids.length === 0) return true;
  const all = getAllTags(custom);
  const tags = filter.ids
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is TagDef => !!t);
  if (tags.length === 0) return true;
  if (filter.mode === 'all') return tags.every((t) => tagMatchesEntry(t, e, paths[t.id]));
  return tags.some((t) => tagMatchesEntry(t, e, paths[t.id]));
}

export function countMatches(
  entries: Entry[],
  tag: TagDef,
  manual: string[] | undefined,
): number {
  let n = 0;
  for (const e of entries) if (tagMatchesEntry(tag, e, manual)) n += 1;
  return n;
}

export function newTagId(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 6);
  return `c-${base || 'tag'}-${rand}`;
}
