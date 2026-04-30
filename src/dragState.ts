// Shared drag state for in-app drag-and-drop (tab ↔ tab, file ↔ sidebar).
//
// FileRow/FileGrid call fm.dragStart(paths) for OS-native drag-out and also
// preventDefault on dragstart, which strips dataTransfer data. So in-app drop
// targets can't rely on dataTransfer — they read the current drag payload
// from this module instead.
//
// External drags (Finder → Breeze) come through dataTransfer.files instead;
// resolveDropPaths() unifies both sources so drop targets accept either.

import { fm } from './bridge';

let paths: string[] = [];
let sourceCwd = '';

export function beginAppDrag(p: string[], cwd: string) {
  paths = [...p];
  sourceCwd = cwd;
}

export function endAppDrag() {
  paths = [];
  sourceCwd = '';
}

export function currentDragPaths(): string[] {
  return paths;
}

export function currentDragSourceCwd(): string {
  return sourceCwd;
}

export function hasAppDrag(): boolean {
  return paths.length > 0;
}

/** Will this drop event yield any paths? Cheap predicate for dragOver
 *  preventDefault (so the cursor shows a copy/move chrome). True for
 *  in-app drags AND any DataTransfer that advertises Files (Finder, web
 *  pages saving an image, etc.) */
export function dragHasAnyPaths(e: React.DragEvent | DragEvent): boolean {
  if (hasAppDrag()) return true;
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // DOMStringList lacks .includes; coerce.
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/** Resolve the absolute paths a drop event carries. Prefers in-app drag
 *  state (because FileRow's native drag-out path strips dataTransfer);
 *  falls back to dataTransfer.files via webUtils.getPathForFile so OS
 *  drags from Finder land in the same code path. Throws if the preload
 *  bridge is missing (older build still loaded — needs a relaunch) or
 *  if every File in the drop produced an empty path (sandboxed source
 *  / web image with no on-disk file). The exception text is surfaced
 *  to the status bar so a "silent" drop is impossible. */
export function resolveDropPaths(e: React.DragEvent | DragEvent): string[] {
  const inApp = currentDragPaths();
  if (inApp.length > 0) return inApp;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return [];
  if (typeof fm.pathForFile !== 'function') {
    throw new Error(
      'preload bridge missing pathForFile — quit and relaunch Breeze to pick up the new build',
    );
  }
  const out: string[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const p = fm.pathForFile(files[i]);
    if (p) out.push(p);
    else skipped.push(files[i].name || '(unnamed)');
  }
  if (out.length === 0) {
    throw new Error(
      `couldn't resolve a real path for ${skipped.length} dropped item${
        skipped.length === 1 ? '' : 's'
      } (${skipped.slice(0, 2).join(', ')}${skipped.length > 2 ? '…' : ''}) — drag from Finder, not a sandboxed app`,
    );
  }
  return out;
}

/** True if the drop is from an external source (Finder, web). Drop
 *  targets that move-by-default should treat external drops as copy
 *  since deleting the source is rude / often impossible. */
export function isExternalDrop(): boolean {
  return !hasAppDrag();
}

/**
 * Drop files into a target folder.
 *
 * Returns a short human-readable status describing what happened — caller
 * pushes it into the status bar. When the drop target equals the source
 * folder, nothing is moved/copied and the returned message nudges the user
 * toward Copy+Paste for an in-place duplicate.
 */
export async function dropIntoFolder(
  paths: string[],
  targetFolder: string,
  sourceCwd: string,
  copy: boolean,
  fm: {
    paste: (
      ops: Array<{ src: string; dst: string; mode: 'copy' | 'move' }>,
    ) => Promise<{ renamed: number }>;
  },
): Promise<string> {
  if (paths.length === 0) return '';
  if (targetFolder === sourceCwd) {
    return 'already here — use Copy then Paste to duplicate in place';
  }
  const mode: 'copy' | 'move' = copy ? 'copy' : 'move';
  const ops = paths.map((src) => {
    const name = src.slice(src.lastIndexOf('/') + 1);
    const dst = `${targetFolder}/${name}`;
    return { src, dst, mode };
  });
  await fm.paste(ops);
  const verb = copy ? 'copied' : 'moved';
  return `${verb} ${paths.length} item${paths.length === 1 ? '' : 's'} to ${targetFolder.slice(targetFolder.lastIndexOf('/') + 1) || targetFolder}`;
}
