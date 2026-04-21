import type { Entry, SortKey } from './types';

export function sortEntries(
  entries: Entry[],
  key: SortKey,
  reverse: boolean,
  showHidden: boolean,
): Entry[] {
  const list = entries.filter((e) => showHidden || !e.isHidden);
  list.sort((a, b) => {
    // Directories always first
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (b.kind === 'dir' && a.kind !== 'dir') return 1;
    let cmp = 0;
    switch (key) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'mtime':
        cmp = a.mtimeMs - b.mtimeMs;
        break;
      case 'ctime':
        cmp = a.ctimeMs - b.ctimeMs;
        break;
      case 'ext':
        cmp = (a.ext ?? '').localeCompare(b.ext ?? '');
        if (cmp === 0) cmp = a.name.localeCompare(b.name);
        break;
      case 'type': {
        const order = { dir: 0, link: 1, exec: 2, file: 3 } as const;
        cmp = order[a.kind] - order[b.kind];
        if (cmp === 0) cmp = a.name.localeCompare(b.name);
        break;
      }
    }
    return reverse ? -cmp : cmp;
  });
  return list;
}

export function applyFilter(entries: Entry[], filter: string): Entry[] {
  if (!filter) return entries;
  const q = filter.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let n = bytes;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatMtime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mon = d.toLocaleString(undefined, { month: 'short' });
  const day = d.getDate().toString().padStart(2, '0');
  if (sameYear) {
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${mon} ${day} ${hh}:${mm}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}
