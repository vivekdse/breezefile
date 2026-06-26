// fm-5xy — PURE selector for start-at / near-due task reminders.
//
// Given a set of dated tasks plus "today"/"tomorrow" (day-only 'YYYY-MM-DD'
// strings) and the user's reminder mode, decide which tasks should be surfaced
// in a reminder right now. No I/O, no Date.now(), no electron — so it's trivially
// unit-testable and identical in main, breezed, and tests.
//
// Modes (mirrors the renderer setting):
//   'off'            → nothing
//   'start'          → tasks whose start_at === today (DEFAULT)
//   'start-near-due' → start-today PLUS tasks whose due_at === tomorrow
//
// Dedupe: a task is skipped if its last_notified_for_date already equals
// `today` — i.e. we already reminded about it today (across restarts and the
// daily 8am tick). A task that qualifies on BOTH legs (start today AND due
// tomorrow) is reported ONCE, under `startToday` (start wins).
//
// PHI: tasks carry titles which MAY be PHI for remote sources. This selector
// only routes ids/dates; the CALLER is responsible for building a PHI-free
// grouped notification body (e.g. "3 tasks start today") rather than echoing
// any title.

/**
 * @typedef {Object} ReminderTask
 * @property {string} id
 * @property {string|null} [start_at]  day-only 'YYYY-MM-DD' or null
 * @property {string|null} [due_at]    day-only 'YYYY-MM-DD' or null
 * @property {string|null} [last_notified_for_date] day-only 'YYYY-MM-DD' or null
 */

/**
 * @typedef {'off'|'start'|'start-near-due'} ReminderMode
 */

/**
 * Select the tasks to remind about for a given day.
 *
 * @param {Object} args
 * @param {ReminderTask[]} args.tasks    candidate tasks (already filtered to non-terminal)
 * @param {string} args.today            local calendar day, 'YYYY-MM-DD'
 * @param {string} args.tomorrow         next local calendar day, 'YYYY-MM-DD'
 * @param {ReminderMode} args.mode       user's reminder mode
 * @returns {{ startToday: ReminderTask[], dueTomorrow: ReminderTask[] }}
 */
export function selectReminderTasks({ tasks, today, tomorrow, mode }) {
  if (mode === 'off' || !Array.isArray(tasks)) {
    return { startToday: [], dueTomorrow: [] };
  }
  const wantNearDue = mode === 'start-near-due';
  const startToday = [];
  const dueTomorrow = [];
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') continue;
    // Already reminded about this task today → skip entirely.
    if (t.last_notified_for_date === today) continue;
    const startsToday = t.start_at === today;
    if (startsToday) {
      startToday.push(t);
      continue; // start wins; never double-count under due-tomorrow.
    }
    if (wantNearDue && t.due_at === tomorrow) {
      dueTomorrow.push(t);
    }
  }
  return { startToday, dueTomorrow };
}

/** Normalize a free-form reminder-mode value to a known mode, defaulting to
 *  'start' (the product default). Used by the main-process settings mirror. */
export function normalizeReminderMode(v) {
  return v === 'off' || v === 'start' || v === 'start-near-due' ? v : 'start';
}
