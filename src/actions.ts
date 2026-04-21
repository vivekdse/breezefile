import type { Entry, Tab } from './types';
import { fm } from './bridge';
import { applyFilter, sortEntries } from './sort';

export function visibleEntries(
  entries: Entry[] | undefined,
  tab: Tab,
): Entry[] {
  if (!entries) return [];
  return applyFilter(sortEntries(entries, tab.sortKey, tab.sortReverse, tab.showHidden), tab.filter);
}

export function lastCol(tab: Tab): number {
  return tab.trail.length - 1;
}

export function currentEntry(tab: Tab, entries: Entry[]): Entry | undefined {
  const sel = tab.selected[lastCol(tab)] ?? 0;
  return entries[sel];
}

export function pathJoin(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return a + '/' + b;
}

export function dirname(p: string): string {
  if (p === '/' || p === '') return '/';
  const stripped = p.replace(/\/+$/, '');
  const idx = stripped.lastIndexOf('/');
  if (idx <= 0) return '/';
  return stripped.slice(0, idx);
}

export function basename(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  const idx = stripped.lastIndexOf('/');
  return idx < 0 ? stripped : stripped.slice(idx + 1);
}

export async function revealInFinder(p: string) {
  await fm.reveal(p);
}

export async function copyPathToClipboard(p: string) {
  await fm.clipboardWrite(p);
}
