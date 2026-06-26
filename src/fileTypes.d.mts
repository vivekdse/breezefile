// fm-o5z8 — type surface for the pure fileTypes.mjs registry helpers.

/** Default seed of editor-editable extensions (no leading dots, lowercase). */
export const DEFAULT_EDITABLE_EXTS: string[];

/** Normalize an extension: lowercase, strip leading dot(s), trim. */
export function normalizeExt(ext: string): string;

/** PURE editability test against an explicit extension set. */
export function isEditable(ext: string, exts: Iterable<string>): boolean;

/** Normalized extension of a path/name, or "" when there is none. */
export function extOf(pathOrName: string): string;
