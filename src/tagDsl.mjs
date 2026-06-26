// fm-j80 — DSL parser & evaluator: a PURE-FUNCTION predicate engine over file
// metadata. NO file content access and the evaluator has NO fs dependencies —
// it operates on a passed-in `fileRow` object (and an injectable tag resolver +
// injectable `now` for deterministic tests).
//
// Authored as plain ESM (with a co-located tagDsl.d.mts for the TS app) so
// `node --test tests/` can import it directly on Node without a transpile step.
// No React, no IPC, no DOM, no fs. Hand-written tokenizer + recursive-descent
// parser keeps it dependency-light and pure.
//
// This is the predicate engine the Tagging epic's tag store (fm-a2k) builds on.
// `tag:name` atoms let one tag reference another tag's match set; the evaluator
// stays fs-free because the CALLER supplies how to resolve a tag name to a
// membership test via opts.resolveTag.
//
// Grammar (lowest → highest precedence):
//   expr    := orExpr
//   orExpr  := andExpr ('or' andExpr)*
//   andExpr := notExpr ('and' notExpr)*
//   notExpr := 'not' notExpr | primary
//   primary := '(' expr ')' | tagAtom | comparison
//   tagAtom := 'tag' ':' name
//   comparison :=
//        field 'between' value 'and' value
//      | field 'in' '(' value (',' value)* ')'
//      | field 'glob' string
//      | field op value
//      | field                     (bool-field truthiness shorthand)
//   op := '=' | '!=' | '>' | '<' | '>=' | '<=' | '~' | '!~'
//
// Atoms (metadata fields): name ext path parent depth size mtime ctime atime
//   birthtime is_dir is_symlink is_hidden mime
//
// Literals: bare numbers, sizes (1MB 1.5GB), durations (7d 2h), quoted strings,
//   `now`, relative (now-30d / now+2h), ISO dates (2024-01-01,
//   2024-01-01T12:00:00Z), booleans (true/false), and bare words (strings).

// ── Field catalogue ────────────────────────────────────────────────────────
// kind drives literal coercion + which operators are sensible.
//   'string'  — name, ext, path, parent, mime
//   'number'  — depth, size  (size accepts byte-unit literals)
//   'time'    — mtime, ctime, atime, birthtime (epoch ms; accept date/now/dur)
//   'bool'    — is_dir, is_symlink, is_hidden
export const FIELDS = {
  name: 'string',
  ext: 'string',
  path: 'string',
  parent: 'string',
  mime: 'string',
  depth: 'number',
  size: 'number',
  mtime: 'time',
  ctime: 'time',
  atime: 'time',
  birthtime: 'time',
  is_dir: 'bool',
  is_symlink: 'bool',
  is_hidden: 'bool',
};

const COMPARISON_OPS = new Set(['=', '!=', '>', '<', '>=', '<=', '~', '!~']);

// Size units (for `size`). KB/MB/GB/TB are BINARY (1024-based) to match the
// file-manager convention used elsewhere in the repo (tags.ts: 4 * 1024 * 1024).
// SI variants (kbsi… not offered) are intentionally omitted; the explicit
// *iB aliases (KiB/MiB…) are also binary and provided for clarity.
const SIZE_UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

// Duration units (for relative dates like now-7d) → milliseconds.
// NOTE: in durations 'm' means minutes (sizes use a separate table above).
const DURATION_UNITS = {
  s: 1000,
  sec: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  wk: 7 * 24 * 60 * 60 * 1000,
};

// ── Errors ─────────────────────────────────────────────────────────────────
export class ParseError extends Error {
  constructor(message, pos) {
    super(pos == null ? message : `${message} (at position ${pos})`);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

// ── Tokenizer ──────────────────────────────────────────────────────────────
// Token kinds: 'op' '(' ')' ',' ':' 'word' 'string' 'number' 'eof'

function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isWordStart(c) {
  return isAlpha(c) || c === '_' || c === '.' || c === '/' || c === '*' || c === '?';
}
function isWordChar(c) {
  // word body allows what a value/path/glob/ISO-date might contain, but NOT
  // ':' (so `tag:name` splits) and NOT the operator/paren/comma chars.
  return (
    isAlpha(c) ||
    isDigit(c) ||
    c === '_' ||
    c === '.' ||
    c === '-' ||
    c === '/' ||
    c === '*' ||
    c === '?' ||
    c === '+'
  );
}

function tokenize(input) {
  const toks = [];
  const n = input.length;
  let i = 0;
  const push = (type, value, pos) => toks.push({ type, value, pos });

  while (i < n) {
    const c = input[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '(') {
      push('(', '(', i);
      i += 1;
      continue;
    }
    if (c === ')') {
      push(')', ')', i);
      i += 1;
      continue;
    }
    if (c === ',') {
      push(',', ',', i);
      i += 1;
      continue;
    }
    if (c === ':') {
      push(':', ':', i);
      i += 1;
      continue;
    }

    // operators (multi-char first)
    if (c === '!') {
      if (input[i + 1] === '=') {
        push('op', '!=', i);
        i += 2;
        continue;
      }
      if (input[i + 1] === '~') {
        push('op', '!~', i);
        i += 2;
        continue;
      }
      throw new ParseError("unexpected '!' (did you mean '!=' or '!~'?)", i);
    }
    if (c === '>' || c === '<') {
      if (input[i + 1] === '=') {
        push('op', c + '=', i);
        i += 2;
        continue;
      }
      push('op', c, i);
      i += 1;
      continue;
    }
    if (c === '=') {
      // accept '==' as an alias for '='
      push('op', '=', i);
      i += input[i + 1] === '=' ? 2 : 1;
      continue;
    }
    if (c === '~') {
      push('op', '~', i);
      i += 1;
      continue;
    }

    // quoted strings ('...' or "...") with backslash escapes
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i += 1;
      let str = '';
      let closed = false;
      while (i < n) {
        const ch = input[i];
        if (ch === '\\') {
          const next = input[i + 1];
          if (next === undefined) break;
          str += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (ch === quote) {
          closed = true;
          i += 1;
          break;
        }
        str += ch;
        i += 1;
      }
      if (!closed) throw new ParseError('unterminated string literal', start);
      push('string', str, start);
      continue;
    }

    // ISO date / datetime starting with a year: YYYY-MM-DD[THH:MM:SS[.sss][Z|±hh:mm]].
    // Detected before the plain-number branch so the dashes/colons don't split.
    // Heuristic: 4 digits followed by '-' and a digit → an ISO date token.
    if (isDigit(c) && /^\d{4}-\d/.test(input.slice(i, i + 6))) {
      const start = i;
      while (i < n && /[0-9T:.+\-Z]/.test(input[i])) i += 1;
      push('word', input.slice(start, i), start);
      continue;
    }

    // numbers: digits, optional decimal, optional trailing unit letters glued on
    // (e.g. "1.5GB", "30d"). The unit travels as part of the number token value.
    if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
      const start = i;
      while (i < n && (isDigit(input[i]) || input[i] === '.')) i += 1;
      while (i < n && isAlpha(input[i])) i += 1; // glued unit
      push('number', input.slice(start, i), start);
      continue;
    }

    // bare words: identifiers, keywords, ISO dates, bare values.
    if (isWordStart(c)) {
      const start = i;
      while (i < n && isWordChar(input[i])) i += 1;
      push('word', input.slice(start, i), start);
      continue;
    }

    throw new ParseError(`unexpected character '${c}'`, i);
  }

  push('eof', null, n);
  return toks;
}

// ── Literal helpers ──────────────────────────────────────────────────────────

// Parse a number that may carry a SIZE unit (→ bytes). Bare number → as-is.
function parseSizeOrNumber(raw, pos) {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(raw);
  if (!m) throw new ParseError(`invalid number '${raw}'`, pos);
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === '') return num;
  if (unit in SIZE_UNITS) return Math.round(num * SIZE_UNITS[unit]);
  throw new ParseError(`unknown size unit '${m[2]}'`, pos);
}

// Parse a duration literal like 7d, 2h, 30min → milliseconds.
function parseDurationMs(raw, pos) {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]+)$/.exec(raw);
  if (!m) throw new ParseError(`invalid duration '${raw}'`, pos);
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit in DURATION_UNITS) return Math.round(num * DURATION_UNITS[unit]);
  throw new ParseError(`unknown duration unit '${m[2]}'`, pos);
}

// Parse `now`, `now-30d`, `now+2h` → a time literal with a lazy now offset.
function parseNowExpr(raw, pos) {
  const lower = raw.toLowerCase();
  if (lower === 'now') return { kind: 'time', nowOffsetMs: 0 };
  const m = /^now([+-])(.+)$/.exec(lower);
  if (!m) throw new ParseError(`invalid relative date '${raw}'`, pos);
  const sign = m[1] === '-' ? -1 : 1;
  const ms = parseDurationMs(m[2], pos);
  return { kind: 'time', nowOffsetMs: sign * ms };
}

// Parse an absolute time literal: epoch ms (bare number), or ISO date/datetime.
function parseTimeLiteral(raw, pos) {
  if (/^\d+$/.test(raw)) return { kind: 'time', value: Number(raw) };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new ParseError(`invalid date '${raw}'`, pos);
  return { kind: 'time', value: ms };
}

function describeTok(t) {
  if (!t || t.type === 'eof') return 'end of input';
  if (t.type === 'word' || t.type === 'number') return `'${t.value}'`;
  if (t.type === 'string') return `string '${t.value}'`;
  if (t.type === 'op') return `operator '${t.value}'`;
  return `'${t.value}'`;
}

// ── Parser (recursive descent; enforces end-of-input) ────────────────────────
// AST node shapes (see tagDsl.d.mts):
//   { type: 'and', left, right }
//   { type: 'or',  left, right }
//   { type: 'not', expr }
//   { type: 'tag', name }                         — tag:name atom
//   { type: 'compare', field, op, value }         — value is a Literal
//   { type: 'in', field, values }                 — values: Literal[]
//   { type: 'between', field, low, high }          — low/high: Literal
//   { type: 'glob', field, pattern }               — pattern: string
//
// Literal: one of
//   { kind:'string', value:string }
//   { kind:'number', value:number }                 (sizes resolved to bytes)
//   { kind:'bool',   value:boolean }
//   { kind:'time',   value:<epoch ms> }              absolute
//   { kind:'time',   nowOffsetMs:<ms> }              now + offset (lazy)
function parse(input) {
  if (typeof input !== 'string') throw new ParseError('query must be a string');
  if (input.trim() === '') throw new ParseError('empty query');

  const toks = tokenize(input);
  let p = 0;

  const peek = () => toks[p];
  const next = () => toks[p++];
  const at = (type, value) => {
    const t = toks[p];
    if (t.type !== type) return false;
    if (value === undefined) return true;
    if (t.type === 'word') return t.value.toLowerCase() === value;
    return t.value === value;
  };
  const isKeyword = (kw) => at('word') && peek().value.toLowerCase() === kw;
  const expect = (type, msg) => {
    const t = peek();
    if (t.type !== type) throw new ParseError(msg ?? `expected ${type}`, t.pos);
    return next();
  };

  function parseExpr() {
    return parseOr();
  }
  function parseOr() {
    let left = parseAnd();
    while (isKeyword('or')) {
      next();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isKeyword('and')) {
      next();
      left = { type: 'and', left, right: parseNot() };
    }
    return left;
  }
  function parseNot() {
    if (isKeyword('not')) {
      next();
      return { type: 'not', expr: parseNot() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (t.type === '(') {
      next();
      const e = parseExpr();
      expect(')', "expected ')'");
      return e;
    }
    if (t.type === 'eof') throw new ParseError('unexpected end of input', t.pos);
    if (isKeyword('tag')) {
      next();
      expect(':', "expected ':' after 'tag'");
      const nameTok = peek();
      if (nameTok.type !== 'word' && nameTok.type !== 'string')
        throw new ParseError('expected a tag name after tag:', nameTok.pos);
      next();
      return { type: 'tag', name: String(nameTok.value) };
    }
    return parseComparison();
  }
  function parseComparison() {
    const fieldTok = peek();
    if (fieldTok.type !== 'word')
      throw new ParseError(`expected a field name, got ${describeTok(fieldTok)}`, fieldTok.pos);
    const field = fieldTok.value.toLowerCase();
    if (!(field in FIELDS)) throw new ParseError(`unknown field '${fieldTok.value}'`, fieldTok.pos);
    next();
    const kind = FIELDS[field];

    // bool field with no operator → truthiness shorthand: `is_dir` ≡ `is_dir = true`
    if (
      kind === 'bool' &&
      !at('op') &&
      !isKeyword('in') &&
      !isKeyword('between') &&
      !isKeyword('glob')
    ) {
      return { type: 'compare', field, op: '=', value: { kind: 'bool', value: true } };
    }

    if (isKeyword('glob')) {
      next();
      const patTok = peek();
      if (patTok.type !== 'string' && patTok.type !== 'word' && patTok.type !== 'number')
        throw new ParseError('expected a glob pattern', patTok.pos);
      next();
      return { type: 'glob', field, pattern: String(patTok.value) };
    }

    if (isKeyword('in')) {
      next();
      expect('(', "expected '(' after 'in'");
      const values = [];
      if (!at(')')) {
        values.push(parseLiteral(kind));
        while (at(',')) {
          next();
          values.push(parseLiteral(kind));
        }
      }
      expect(')', "expected ')' to close 'in (...)'");
      if (values.length === 0) throw new ParseError("'in' needs at least one value", fieldTok.pos);
      return { type: 'in', field, values };
    }

    if (isKeyword('between')) {
      next();
      const low = parseLiteral(kind);
      if (!isKeyword('and')) throw new ParseError("expected 'and' in 'between … and …'", peek().pos);
      next();
      const high = parseLiteral(kind);
      return { type: 'between', field, low, high };
    }

    if (!at('op'))
      throw new ParseError(
        `expected an operator after '${field}', got ${describeTok(peek())}`,
        peek().pos,
      );
    const op = next().value;
    if (!COMPARISON_OPS.has(op)) throw new ParseError(`unknown operator '${op}'`, peek().pos);
    const value = parseLiteral(kind, op);
    return { type: 'compare', field, op, value };
  }

  // Parse a single literal, coercing based on the field's kind (and operator).
  function parseLiteral(kind, op) {
    const t = peek();
    const isMatch = op === '~' || op === '!~';

    if (t.type === 'string') {
      next();
      return isMatch ? { kind: 'string', value: t.value } : coerceString(kind, t.value, t.pos);
    }
    if (t.type === 'number') {
      next();
      return isMatch ? { kind: 'string', value: t.value } : coerceNumeric(kind, t.value, t.pos);
    }
    if (t.type === 'word') {
      const w = t.value;
      const lower = w.toLowerCase();
      if (lower === 'true' || lower === 'false') {
        next();
        return isMatch ? { kind: 'string', value: w } : { kind: 'bool', value: lower === 'true' };
      }
      if (lower === 'now' || lower.startsWith('now+') || lower.startsWith('now-')) {
        next();
        return isMatch ? { kind: 'string', value: w } : parseNowExpr(w, t.pos);
      }
      next();
      return isMatch ? { kind: 'string', value: w } : coerceString(kind, w, t.pos);
    }
    throw new ParseError(`expected a value, got ${describeTok(t)}`, t.pos);
  }

  function coerceString(kind, raw, pos) {
    if (kind === 'string') return { kind: 'string', value: raw };
    if (kind === 'bool') {
      const l = raw.toLowerCase();
      if (l === 'true') return { kind: 'bool', value: true };
      if (l === 'false') return { kind: 'bool', value: false };
      throw new ParseError(`expected true/false, got '${raw}'`, pos);
    }
    if (kind === 'number') return { kind: 'number', value: parseSizeOrNumber(raw, pos) };
    if (kind === 'time') return parseTimeLiteral(raw, pos);
    throw new ParseError(`cannot use '${raw}' here`, pos);
  }

  function coerceNumeric(kind, raw, pos) {
    if (kind === 'time') return parseTimeLiteral(raw, pos);
    if (kind === 'string') return { kind: 'string', value: raw };
    return { kind: 'number', value: parseSizeOrNumber(raw, pos) };
  }

  const ast = parseExpr();
  if (peek().type !== 'eof')
    throw new ParseError(`unexpected ${describeTok(peek())} after expression`, peek().pos);
  return ast;
}

// ── Evaluator (pure; fs-free) ────────────────────────────────────────────────
// evaluate(ast, fileRow, opts?) -> boolean
//
// fileRow is a plain object with the metadata fields. We accept BOTH the DSL
// field names (size, mtime, is_dir, …) and the repo's Entry shape (mtimeMs,
// kind, isHidden, …), normalizing on read so callers can pass an Entry directly.
//
// opts:
//   now: number | (() => number)   — injectable clock for now/relative dates
//   resolveTag: (name, fileRow) => boolean
//        — membership test for a tag:name atom. The CALLER decides how a tag
//          resolves (predicate, manual set, recursive DSL, …). Keeping this
//          injectable is what makes the evaluator pure / fs-free. If a tag atom
//          is encountered and no resolver is supplied, evaluation throws.

function nowMs(opts) {
  const now = opts?.now;
  if (typeof now === 'function') return now();
  if (typeof now === 'number') return now;
  return Date.now();
}

function basename(pth) {
  const cleaned = pth.replace(/\/+$/, '');
  const i = cleaned.lastIndexOf('/');
  return i < 0 ? cleaned : cleaned.slice(i + 1);
}
function dirname(pth) {
  const cleaned = pth.replace(/\/+$/, '');
  const i = cleaned.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return cleaned.slice(0, i);
}
function depthOf(pth) {
  const trimmed = pth.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? 0 : trimmed.split('/').length;
}

// Resolve a field value off fileRow, normalizing Entry-shape fallbacks.
function fieldValue(field, row) {
  switch (field) {
    case 'name':
      return row.name ?? (row.path != null ? basename(String(row.path)) : undefined);
    case 'ext': {
      if (row.ext != null) return String(row.ext).replace(/^\./, '').toLowerCase();
      const nm = row.name ?? (row.path != null ? basename(String(row.path)) : '');
      const dot = String(nm).lastIndexOf('.');
      return dot > 0 ? String(nm).slice(dot + 1).toLowerCase() : '';
    }
    case 'path':
      return row.path;
    case 'parent':
      return row.parent ?? (row.path != null ? dirname(String(row.path)) : undefined);
    case 'depth':
      return row.depth ?? (row.path != null ? depthOf(String(row.path)) : undefined);
    case 'size':
      return row.size;
    case 'mtime':
      return row.mtime ?? row.mtimeMs;
    case 'ctime':
      return row.ctime ?? row.ctimeMs;
    case 'atime':
      return row.atime ?? row.atimeMs;
    case 'birthtime':
      return row.birthtime ?? row.birthtimeMs;
    case 'mime':
      return row.mime;
    case 'is_dir':
      return row.is_dir ?? (row.kind != null ? row.kind === 'dir' : undefined);
    case 'is_symlink':
      return row.is_symlink ?? (row.kind != null ? row.kind === 'link' : undefined);
    case 'is_hidden':
      return row.is_hidden ?? row.isHidden;
    default:
      return undefined;
  }
}

// Resolve a literal to a concrete comparable value at evaluate time.
function literalValue(lit, opts) {
  if (lit.kind === 'time') {
    if (lit.value != null) return lit.value;
    return nowMs(opts) + (lit.nowOffsetMs ?? 0);
  }
  return lit.value;
}

// glob → RegExp. Supports * (run, no /), ** (run incl /), ? (one non-/ char),
// and [..] / [!..] character classes. Anchored full-match.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      let cls = '[';
      i += 1;
      if (glob[i] === '!' || glob[i] === '^') {
        cls += '^';
        i += 1;
      }
      while (i < glob.length && glob[i] !== ']') {
        const ch = glob[i];
        cls += /[\\^$.*+?()[\]{}|]/.test(ch) && ch !== '-' ? '\\' + ch : ch;
        i += 1;
      }
      cls += ']';
      re += cls;
    } else if (/[\\^$.+()[\]{}|]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function asString(v) {
  return v == null ? '' : String(v);
}
function asBool(v) {
  return v === true || v === 'true' || v === 1;
}

function compareValues(actual, op, lit, opts) {
  // match operators: regex test against string form
  if (op === '~' || op === '!~') {
    const re = new RegExp(asString(lit.value));
    const hit = re.test(asString(actual));
    return op === '~' ? hit : !hit;
  }

  if (lit.kind === 'bool') {
    const a = asBool(actual);
    const b = lit.value;
    if (op === '=') return a === b;
    if (op === '!=') return a !== b;
    throw new ParseError(`operator '${op}' is not valid for booleans`);
  }

  if (lit.kind === 'string') {
    const a = asString(actual);
    const b = asString(lit.value);
    switch (op) {
      case '=':
        return a === b;
      case '!=':
        return a !== b;
      case '>':
        return a > b;
      case '<':
        return a < b;
      case '>=':
        return a >= b;
      case '<=':
        return a <= b;
      default:
        throw new ParseError(`operator '${op}' not valid for strings`);
    }
  }

  // number or time → numeric compare
  const a = Number(actual);
  const b = Number(literalValue(lit, opts));
  if (Number.isNaN(a)) return op === '!='; // missing/non-numeric field
  switch (op) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    default:
      throw new ParseError(`operator '${op}' not valid here`);
  }
}

function evaluate(ast, fileRow, opts) {
  if (ast == null || typeof ast !== 'object')
    throw new TypeError('evaluate: ast must be a parsed AST node');
  const row = fileRow ?? {};
  switch (ast.type) {
    case 'and':
      return evaluate(ast.left, row, opts) && evaluate(ast.right, row, opts);
    case 'or':
      return evaluate(ast.left, row, opts) || evaluate(ast.right, row, opts);
    case 'not':
      return !evaluate(ast.expr, row, opts);
    case 'tag': {
      const resolve = opts?.resolveTag;
      if (typeof resolve !== 'function')
        throw new Error(
          `evaluate: encountered tag:${ast.name} but opts.resolveTag was not supplied`,
        );
      return !!resolve(ast.name, row);
    }
    case 'compare':
      return compareValues(fieldValue(ast.field, row), ast.op, ast.value, opts);
    case 'glob':
      return globToRegExp(ast.pattern).test(asString(fieldValue(ast.field, row)));
    case 'in': {
      const actual = fieldValue(ast.field, row);
      return ast.values.some((lit) => compareValues(actual, '=', lit, opts));
    }
    case 'between': {
      const actual = fieldValue(ast.field, row);
      return (
        compareValues(actual, '>=', ast.low, opts) &&
        compareValues(actual, '<=', ast.high, opts)
      );
    }
    default:
      throw new TypeError(`evaluate: unknown AST node type '${ast.type}'`);
  }
}

export { parse, evaluate };

// Internals exposed for focused unit testing.
export const _internal = {
  tokenize,
  parseSizeOrNumber,
  parseDurationMs,
  parseNowExpr,
  parseTimeLiteral,
  globToRegExp,
  fieldValue,
};
