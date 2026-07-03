// task-7bdb94445321 follow-up — SQL-like structured querying of the New Home
// roster. The user wanted "any combination of values, like SQL" — this delivers
// it WITHOUT client-side eval (which the repo forbids — see
// docs/saved-queries-design.md "the client never eval's"). Instead it REUSES
// the existing tag DSL engine (src/tagDsl.mjs): the same hand-written,
// no-eval, recursive-descent parser + AST interpreter the Tagging feature uses,
// pointed at TASK fields via the engine's parameterized field catalogue +
// accessor. One query engine, two record shapes — no mirrored parser.
//
// Grammar (same as tags): boolean and/or/not, parens, comparisons
//   field op value        op ∈ = != > < >= <= ~ !~   (~ / !~ are regex)
//   field in (a, b, c)
//   field between lo and hi
//   field glob "pattern"
//   field                 (bool-field truthiness shorthand)
// e.g.  status = needs and (repeatable or who = agent)
//       status in (needs, failed) and risk ~ retry
//       due between now and now+7d
//
// PHI: evaluation is in-memory over already-loaded roster rows; custom-field
// VALUES may be PHI and are compared in memory only, never logged/persisted
// (same rule the roster already follows).

import { parse, evaluate, type Ast, type FieldCatalogue } from '../../tagDsl.mjs';
import type { NewHomeTask, TemplateField } from './types';

/** Base task fields always queryable, independent of the project template. */
const BASE_FIELDS: FieldCatalogue = {
  title: 'string',
  status: 'string', // done | progress | queued | needs | failed
  who: 'string', // agent | human | both
  project: 'string', // project id
  risk: 'string',
  live: 'bool',
  repeatable: 'bool',
  needs_answer: 'bool', // blocked on a human answer (pendingQuestion)
  last_action: 'time', // epoch ms of most recent activity
  due: 'time', // task due date
};

/** Human-facing field reference for the query box + copilot grounding. */
export const TASK_QUERY_FIELDS: { name: string; kind: string; note: string }[] = [
  { name: 'title', kind: 'string', note: 'task title' },
  { name: 'status', kind: 'string', note: 'done | progress | queued | needs | failed' },
  { name: 'who', kind: 'string', note: 'agent | human | both' },
  { name: 'project', kind: 'string', note: 'project id' },
  { name: 'risk', kind: 'string', note: 'risk/flag annotation' },
  { name: 'live', kind: 'bool', note: 'an agent is actively working it' },
  { name: 'repeatable', kind: 'bool', note: 'marked repeatable' },
  { name: 'needs_answer', kind: 'bool', note: 'blocked on a human answer' },
  { name: 'last_action', kind: 'time', note: 'most recent activity (use now / now-2h / dates)' },
  { name: 'due', kind: 'time', note: 'due date' },
];

function kindForField(f: TemplateField): 'string' | 'number' | 'time' {
  if (f.type === 'date') return 'time';
  if (f.type === 'number') return 'number';
  return 'string';
}

/** Build the field catalogue + accessor for the given project template. Custom
 *  fields are addressable by their (lowercased) key — the DSL lowercases field
 *  tokens, so keys must resolve case-insensitively. Base fields win on any
 *  collision. */
export function buildTaskQuerySchema(templateFields: TemplateField[]): {
  fields: FieldCatalogue;
  fieldValue: (field: string, row: unknown) => unknown;
} {
  const fields: FieldCatalogue = { ...BASE_FIELDS };
  // lowercased custom-field name → { key, kind } for accessor coercion.
  const custom = new Map<string, { key: string; kind: 'string' | 'number' | 'time' }>();
  for (const f of templateFields) {
    const lc = f.key.toLowerCase();
    if (lc in fields) continue; // never shadow a base field
    const kind = kindForField(f);
    fields[lc] = kind;
    custom.set(lc, { key: f.key, kind });
  }

  function fieldValue(field: string, rowUnknown: unknown): unknown {
    const row = rowUnknown as NewHomeTask;
    switch (field) {
      case 'title':
        return row.title;
      case 'status':
        return row.status;
      case 'who':
        return row.who;
      case 'project':
        return row.projectId ?? '';
      case 'risk':
        return row.risk ?? '';
      case 'live':
        return !!row.live;
      case 'repeatable':
        return !!(row.raw as { repeatable?: unknown } | undefined)?.repeatable;
      case 'needs_answer':
        return !!row.pendingQuestion;
      case 'last_action':
        return row.lastActionAt ?? undefined;
      case 'due': {
        const due = (row.raw as { due_at?: string | null } | undefined)?.due_at;
        if (!due) return undefined;
        const ms = Date.parse(due);
        return Number.isNaN(ms) ? undefined : ms;
      }
      default: {
        const meta = custom.get(field);
        if (!meta) return undefined;
        const raw = row.customValues?.[meta.key];
        if (raw == null || raw === '') return undefined;
        if (meta.kind === 'time') {
          const ms = Date.parse(raw);
          return Number.isNaN(ms) ? undefined : ms;
        }
        if (meta.kind === 'number') {
          const n = Number(raw);
          return Number.isNaN(n) ? undefined : n;
        }
        return raw;
      }
    }
  }

  return { fields, fieldValue };
}

export type CompiledTaskQuery = {
  ast: Ast;
  fieldValue: (field: string, row: unknown) => unknown;
};

/** Compile a query string against the project template. Returns the compiled
 *  query on success, or a human-readable error message (the ParseError text,
 *  e.g. "unknown field 'foo'"). Never throws. */
export function compileTaskQuery(
  query: string,
  templateFields: TemplateField[],
): { ok: true; compiled: CompiledTaskQuery } | { ok: false; error: string } {
  const q = query.trim();
  if (!q) return { ok: false, error: 'empty query' };
  const { fields, fieldValue } = buildTaskQuerySchema(templateFields);
  try {
    const ast = parse(q, { fields });
    return { ok: true, compiled: { ast, fieldValue } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Filter tasks by a compiled query. A row that throws during evaluation is
 *  treated as non-matching (defensive; the pure interpreter shouldn't throw on
 *  well-formed rows, but a malformed custom value must not crash the roster). */
export function runTaskQuery(tasks: NewHomeTask[], compiled: CompiledTaskQuery, now: number): NewHomeTask[] {
  return tasks.filter((t) => {
    try {
      return evaluate(compiled.ast, t, { fieldValue: compiled.fieldValue, now });
    } catch {
      return false;
    }
  });
}
