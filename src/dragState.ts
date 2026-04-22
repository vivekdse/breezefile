// Shared drag state for in-app drag-and-drop (tab ↔ tab, file ↔ sidebar).
//
// FileRow/FileGrid call fm.dragStart(paths) for OS-native drag-out and also
// preventDefault on dragstart, which strips dataTransfer data. So in-app drop
// targets can't rely on dataTransfer — they read the current drag payload
// from this module instead.

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
