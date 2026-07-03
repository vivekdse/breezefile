// fm-j80 — type surface for the pure tagDsl.mjs predicate engine (runtime is
// plain ESM so the node test runner can import it without a transpile step).
//
// A PURE predicate engine over file metadata: parse(query) -> AST, and
// evaluate(ast, fileRow, opts?) -> boolean. The evaluator has NO fs deps; it
// reads from a passed-in fileRow and resolves tag:name atoms via an injectable
// opts.resolveTag callback. `now` is injectable for deterministic tests.

/** Metadata field names usable as predicate atoms. */
export type FieldName =
  | 'name'
  | 'ext'
  | 'path'
  | 'parent'
  | 'mime'
  | 'depth'
  | 'size'
  | 'mtime'
  | 'ctime'
  | 'atime'
  | 'birthtime'
  | 'is_dir'
  | 'is_symlink'
  | 'is_hidden';

/** Field → value-kind map (drives literal coercion in the parser). */
export const FIELDS: Record<FieldName, 'string' | 'number' | 'time' | 'bool'>;

export type CompareOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | '~' | '!~';

/** A parsed literal. Sizes resolve to bytes; `time` is either an absolute
 *  epoch-ms `value` or a lazy `nowOffsetMs` (resolved at evaluate time using
 *  opts.now). */
export type Literal =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'time'; value: number }
  | { kind: 'time'; nowOffsetMs: number };

/** The AST. `tag` is the self-reference atom resolved via opts.resolveTag.
 *  `field` is a string: for the default file catalogue it's a FieldName, but a
 *  custom parse({fields}) catalogue (e.g. task fields) allows any declared
 *  field name. */
export type Ast =
  | { type: 'and'; left: Ast; right: Ast }
  | { type: 'or'; left: Ast; right: Ast }
  | { type: 'not'; expr: Ast }
  | { type: 'tag'; name: string }
  | { type: 'compare'; field: string; op: CompareOp; value: Literal }
  | { type: 'in'; field: string; values: Literal[] }
  | { type: 'between'; field: string; low: Literal; high: Literal }
  | { type: 'glob'; field: string; pattern: string };

/** A row of file metadata. Accepts DSL names AND the repo Entry shape
 *  (mtimeMs/kind/isHidden), normalized on read. Fully optional — missing
 *  fields evaluate as absent. NO file content. */
export interface FileRow {
  name?: string;
  ext?: string;
  path?: string;
  parent?: string;
  depth?: number;
  size?: number;
  mime?: string;
  mtime?: number;
  ctime?: number;
  atime?: number;
  birthtime?: number;
  is_dir?: boolean;
  is_symlink?: boolean;
  is_hidden?: boolean;
  // Entry-shape fallbacks:
  mtimeMs?: number;
  ctimeMs?: number;
  atimeMs?: number;
  birthtimeMs?: number;
  kind?: string;
  isHidden?: boolean;
  [k: string]: unknown;
}

/** Value-kind catalogue: field name → coercion kind. */
export type FieldCatalogue = Record<string, 'string' | 'number' | 'time' | 'bool'>;

export interface ParseOpts {
  /** Field catalogue to validate names against + drive literal coercion.
   *  Defaults to the file-metadata FIELDS. Supply a different one (e.g. task
   *  fields) to parse queries over a different record shape with the same
   *  grammar. */
  fields?: FieldCatalogue;
}

export interface EvalOpts {
  /** Injectable clock for `now` / relative dates. Number or thunk. */
  now?: number | (() => number);
  /** Membership test for a `tag:name` atom. The caller decides how a tag name
   *  resolves to a boolean for this row (predicate, manual set, nested DSL …).
   *  Required only if the AST contains a `tag` atom. */
  resolveTag?: (name: string, row: FileRow) => boolean;
  /** Field accessor: resolve a field name to a value off `row`. Defaults to the
   *  file-metadata accessor. Supply one to evaluate against a different record
   *  shape (e.g. a task). */
  fieldValue?: (field: string, row: unknown) => unknown;
}

export class ParseError extends Error {
  pos?: number;
}

/** Parse a query string into an AST. Throws ParseError on bad input. */
export function parse(query: string, opts?: ParseOpts): Ast;

/** Evaluate a parsed AST against a row. Pure; no fs access. With a custom
 *  opts.fieldValue the row may be any record shape. */
export function evaluate(ast: Ast, row: FileRow | unknown, opts?: EvalOpts): boolean;

export const _internal: {
  tokenize(input: string): Array<{ type: string; value: unknown; pos: number }>;
  parseSizeOrNumber(raw: string, pos?: number): number;
  parseDurationMs(raw: string, pos?: number): number;
  parseNowExpr(raw: string, pos?: number): Literal;
  parseTimeLiteral(raw: string, pos?: number): Literal;
  globToRegExp(glob: string): RegExp;
  fieldValue(field: FieldName, row: FileRow): unknown;
};
