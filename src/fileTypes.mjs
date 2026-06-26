// fm-o5z8 — pure file-type registry helpers (editor vs OS-default app).
//
// Runtime is plain ESM so the node test runner can import it without a
// transpile step (same pattern as tagDsl.mjs). The stateful localStorage
// layer + React-facing API lives in fileTypes.ts, which re-exports these.
//
// `isEditable(ext, exts)` is PURE: it takes the editable-extension set
// explicitly so it's trivially testable. The stateful wrapper that reads the
// user's current set lives in fileTypes.ts.

/**
 * Default seed of extensions that open in Breeze's in-app editor. Seeded from
 * the TEXT_EXT set in components/Preview.tsx plus the markdown variants that
 * were previously hardcoded (md/mdx). No leading dots; all lowercase.
 */
export const DEFAULT_EDITABLE_EXTS = [
  'md', 'mdx', 'txt', 'log', 'json', 'yml', 'yaml',
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'rb', 'sh', 'zsh', 'bash',
  'html', 'css', 'scss', 'xml', 'toml',
  'conf', 'ini', 'env',
];

/**
 * Normalize an extension to the stored form: lowercase, no leading dot(s),
 * trimmed. Accepts "MD", ".md", " md " etc.
 * @param {string} ext
 * @returns {string}
 */
export function normalizeExt(ext) {
  return String(ext ?? '').trim().toLowerCase().replace(/^\.+/, '');
}

/**
 * PURE editability test. Returns true when `ext` is in `exts`.
 * @param {string} ext  an extension (with or without leading dot)
 * @param {Iterable<string>} exts  the editable-extension set
 * @returns {boolean}
 */
export function isEditable(ext, exts) {
  const norm = normalizeExt(ext);
  if (!norm) return false;
  if (exts instanceof Set) return exts.has(norm);
  for (const e of exts ?? []) {
    if (normalizeExt(e) === norm) return true;
  }
  return false;
}

/**
 * The extension of a file path/name, normalized. "" when there is no
 * meaningful extension (no dot, leading-dot dotfile, or trailing dot).
 * @param {string} pathOrName
 * @returns {string}
 */
export function extOf(pathOrName) {
  const name = String(pathOrName ?? '').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or leading-dot dotfile
  return normalizeExt(name.slice(dot + 1));
}
