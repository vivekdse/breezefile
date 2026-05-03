// Tiny 5-field cron evaluator (epic fm-zf3m).
//
// Format: "min hour dom month dow" — the standard POSIX subset. Each
// field accepts:
//   *           — any
//   N           — exact value
//   N-M         — inclusive range
//   */S or N/S  — step (every S, optionally starting at N)
//   a,b,c       — comma list of any of the above
//   day names: SUN MON TUE WED THU FRI SAT (case-insensitive) for dow
//   month names: JAN FEB ... DEC for month
//
// Interpreted in LOCAL time. Returns the next fire >= `from` (exclusive
// of `from` itself when `inclusive=false`, default). Walks at most a
// few years ahead before giving up to bound worst-case for unsatisfiable
// expressions like "0 0 31 2 *".
//
// We don't pull cron-parser because it adds a dep + native bindings on
// some setups, and we only need the standard subset. If users start
// asking for L / # extensions we revisit.

type Field = {
  values: Set<number>;
  any: boolean;
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): Field {
  if (raw === '*' || raw === '?') return { values: new Set(), any: true };
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = /^(.*)\/(\d+)$/.exec(part);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const head = stepMatch ? stepMatch[1] : part;
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`bad cron step in "${raw}"`);
    }
    let lo: number;
    let hi: number;
    if (head === '*' || head === '') {
      lo = min;
      hi = max;
    } else if (head.includes('-')) {
      const [a, b] = head.split('-').map((s) => resolveName(s, names));
      lo = a;
      hi = b;
    } else {
      const v = resolveName(head, names);
      lo = v;
      hi = stepMatch ? max : v;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field "${raw}" out of range [${min},${max}]`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: out, any: false };
}

function resolveName(s: string, names?: Record<string, number>): number {
  const t = s.trim().toUpperCase();
  if (names && t in names) return names[t];
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`bad cron token: ${s}`);
  return n;
}

export type ParsedCron = {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  raw: string;
};

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${parts.length}: "${expr}"`);
  }
  const [m, h, dom, mon, dow] = parts;
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    // POSIX cron: SUN may be 0 OR 7. We normalise 7→0 by allowing both.
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTH_NAMES),
    dow: parseField(dow.replace(/\b7\b/g, '0'), 0, 6, DOW_NAMES),
    raw: expr,
  };
}

function fieldMatches(f: Field, v: number): boolean {
  return f.any || f.values.has(v);
}

const MAX_YEARS_AHEAD = 5;

/** Next firing time strictly after `from`. Returns ms epoch. Throws on
 *  unsatisfiable expressions (e.g. "0 0 30 2 *"). */
export function nextCronFire(parsed: ParsedCron, from: Date = new Date()): number {
  // Start one minute after `from`, zero out seconds/ms — cron resolution
  // is per-minute, and we never want to "fire now" mistakenly.
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const cutoff = new Date(start);
  cutoff.setFullYear(cutoff.getFullYear() + MAX_YEARS_AHEAD);

  const t = new Date(start);
  // Fixed-step search bounded by cutoff. POSIX cron rule: when both dom
  // and dow are restricted, a day matches if EITHER matches; otherwise
  // the restricted one alone applies.
  while (t <= cutoff) {
    const month = t.getMonth() + 1;
    if (!fieldMatches(parsed.month, month)) {
      t.setDate(1);
      t.setMonth(t.getMonth() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    const dom = t.getDate();
    const dow = t.getDay();
    const domAny = parsed.dom.any;
    const dowAny = parsed.dow.any;
    let dayOk: boolean;
    if (domAny && dowAny) {
      dayOk = true;
    } else if (!domAny && !dowAny) {
      dayOk = parsed.dom.values.has(dom) || parsed.dow.values.has(dow);
    } else if (!domAny) {
      dayOk = parsed.dom.values.has(dom);
    } else {
      dayOk = parsed.dow.values.has(dow);
    }
    if (!dayOk) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fieldMatches(parsed.hour, t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fieldMatches(parsed.minute, t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t.getTime();
  }
  throw new Error(`cron expression has no fire in next ${MAX_YEARS_AHEAD} years: ${parsed.raw}`);
}

/** Convenience: parse + next in one step. Returns ms epoch. */
export function nextFireFromExpr(expr: string, from: Date = new Date()): number {
  return nextCronFire(parseCron(expr), from);
}
