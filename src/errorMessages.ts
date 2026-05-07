/*
 * Plain-English wrapper for raw Node / Electron errors.
 *
 * Errors travel from the main process to the renderer via IPC, which strips
 * the `.code` property — but Node's fs error messages prefix the code in
 * the message itself ("EACCES: permission denied, open '/path'"). We
 * pattern-match those, surface a readable explanation + a next step, and
 * keep the raw message available for the title attribute (power users / bug
 * reports).
 */

export type FriendlyError = {
  /** Short headline a non-developer can read at a glance. */
  message: string;
  /** Original error text — use as title= for hover-on-truncate. */
  raw: string;
};

const PATTERNS: { match: RegExp; render: (raw: string) => string }[] = [
  // Permission denied — the most common new-user surprise on macOS.
  {
    match: /^(EACCES|EPERM)\b/,
    render: () =>
      "Mac blocked this. Check System Settings → Privacy & Security → Files and Folders, then re-enable Breeze for that folder.",
  },
  // File or directory gone — usually a stale view or a moved/deleted source.
  {
    match: /^ENOENT\b/,
    render: () => "That file isn't there anymore. Refresh and try again.",
  },
  // Already exists — paste/rename conflict.
  {
    match: /^EEXIST\b/,
    render: () => "Something with that name already exists here. Rename it or pick a different spot.",
  },
  // Disk full.
  {
    match: /^ENOSPC\b/,
    render: () => "Disk is full. Free some space and try again.",
  },
  // Cross-device move (typical when moving across volumes / external drives).
  {
    match: /^EXDEV\b/,
    render: () => "Can't move across drives. Copy instead, then delete the original.",
  },
  // Read-only filesystem (e.g. a mounted DMG).
  {
    match: /^EROFS\b/,
    render: () => "That location is read-only. Pick a writable folder.",
  },
  // Path / name too long.
  {
    match: /^ENAMETOOLONG\b/,
    render: () => "That name is too long. Try a shorter one.",
  },
  // Not a directory / is a directory mismatches.
  {
    match: /^ENOTDIR\b/,
    render: () => "Expected a folder there but found a file.",
  },
  {
    match: /^EISDIR\b/,
    render: () => "That's a folder, not a file.",
  },
  // Directory not empty (rmdir without recursive).
  {
    match: /^ENOTEMPTY\b/,
    render: () => "Folder isn't empty. Empty it first or use trash.",
  },
  // Too many open files / file descriptor exhaustion.
  {
    match: /^EMFILE\b/,
    render: () => "Mac ran out of file handles. Close some apps and try again.",
  },
  // Operation not permitted on resource (often fsevents / sandbox).
  {
    match: /^EBUSY\b/,
    render: () => "That file is in use by another app. Close it and retry.",
  },
];

/** Translate any thrown value into a readable FriendlyError. */
export function humanizeError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err.message : String(err);
  for (const p of PATTERNS) {
    if (p.match.test(raw)) {
      return { message: p.render(raw), raw };
    }
  }
  // No pattern matched — surface the raw message as-is. Power users still
  // get the truth; we just don't pretend to know what it means.
  return { message: raw, raw };
}

/**
 * Convenience: produce a status-line string with an action prefix.
 *
 *   formatOpError('paste', err) → "paste failed — Mac blocked this. Check…"
 *
 * Use this anywhere you previously wrote `${op} failed: ${(err as Error).message}`.
 */
export function formatOpError(op: string, err: unknown): string {
  const f = humanizeError(err);
  return `${op} failed — ${f.message}`;
}
