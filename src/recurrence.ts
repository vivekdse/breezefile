// Renderer-side recurrence helpers (epic fm-zf3m).
//
// The dialog edits a structured form (kind + time + days). On submit we
// compile to a 5-field cron string that the server stores verbatim. On
// open of an existing task we run the inverse: parse a known cron back
// into the form, falling back to "custom" for anything we didn't emit.
//
// Cron is interpreted in LOCAL time by the server (electron/cron.ts).

export type RecurrenceKind =
  | 'once'      // no recurrence — one-shot run on save (cron = null)
  | 'daily'     // every day at HH:MM
  | 'weekdays'  // Mon–Fri at HH:MM
  | 'weekly'    // selected days at HH:MM
  | 'custom';   // raw cron expression

export type RecurrenceForm = {
  kind: RecurrenceKind;
  /** 'HH:MM' (24h) — used by daily/weekdays/weekly. */
  time: string;
  /** Selected days for 'weekly' (0 = Sun … 6 = Sat). */
  days: number[];
  /** Raw cron for 'custom'. */
  cron: string;
};

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon-first display

export function defaultRecurrenceForm(): RecurrenceForm {
  return { kind: 'once', time: '09:00', days: [1, 2, 3, 4, 5], cron: '' };
}

function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** Compile the form to a cron string, or null when kind === 'once'.
 *  Throws when the form is invalid (bad time, no days selected, empty
 *  custom expression). */
export function buildCronFromForm(f: RecurrenceForm): string | null {
  if (f.kind === 'once') return null;
  if (f.kind === 'custom') {
    const trimmed = f.cron.trim();
    if (!trimmed) throw new Error('Cron expression is required');
    if (trimmed.split(/\s+/).length !== 5) {
      throw new Error('Cron must have 5 space-separated fields');
    }
    return trimmed;
  }
  const t = parseTime(f.time);
  if (!t) throw new Error('Time must be HH:MM (24h)');
  if (f.kind === 'daily') return `${t.m} ${t.h} * * *`;
  if (f.kind === 'weekdays') return `${t.m} ${t.h} * * 1-5`;
  if (f.kind === 'weekly') {
    if (f.days.length === 0) throw new Error('Pick at least one weekday');
    const sorted = [...new Set(f.days)].sort((a, b) => a - b).join(',');
    return `${t.m} ${t.h} * * ${sorted}`;
  }
  // exhaustiveness — TS will flag a new kind that lands here
  throw new Error(`Unknown recurrence kind: ${f.kind satisfies never}`);
}

/** Inverse of buildCronFromForm. Recognises the patterns we emit and
 *  classifies anything else as 'custom' so the user can still edit it. */
export function parseCronToForm(cron: string | null): RecurrenceForm {
  if (!cron) return defaultRecurrenceForm();
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ...defaultRecurrenceForm(), kind: 'custom', cron };
  }
  const [m, h, dom, mon, dow] = parts;
  const minute = Number(m);
  const hour = Number(h);
  const simpleClock =
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59 &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    dom === '*' &&
    mon === '*';
  if (!simpleClock) {
    return { ...defaultRecurrenceForm(), kind: 'custom', cron };
  }
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (dow === '*') {
    return { ...defaultRecurrenceForm(), kind: 'daily', time };
  }
  if (dow === '1-5') {
    return { ...defaultRecurrenceForm(), kind: 'weekdays', time };
  }
  // Comma list of single digits → weekly with that day set.
  if (/^[0-6](,[0-6])*$/.test(dow)) {
    const days = dow.split(',').map(Number);
    return { ...defaultRecurrenceForm(), kind: 'weekly', time, days };
  }
  return { ...defaultRecurrenceForm(), kind: 'custom', cron };
}

/** Human description for the form preview ("Daily at 09:00", etc.).
 *  Doesn't compute the actual next fire — that's the server's job. */
export function describeCron(f: RecurrenceForm): string {
  switch (f.kind) {
    case 'once':     return 'Runs once on save.';
    case 'daily':    return `Every day at ${f.time}.`;
    case 'weekdays': return `Mon–Fri at ${f.time}.`;
    case 'weekly': {
      if (f.days.length === 0) return 'Pick at least one day.';
      const ordered = DOW_ORDER.filter((d) => f.days.includes(d));
      const labels = ordered.map((d) => DOW_LABELS[d]).join(', ');
      return `${labels} at ${f.time}.`;
    }
    case 'custom':
      return f.cron.trim() ? `Custom: ${f.cron.trim()}` : 'Enter a cron expression.';
  }
}

export const DAY_LABELS = DOW_LABELS;
