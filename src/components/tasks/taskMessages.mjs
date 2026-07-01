// task-da23979fd907 — the pure layer behind the USER-facing task MESSAGES feed.
//
// `messages` is an append-only, newest-last status channel distinct from `notes`
// (claim-holder-only AGENT progress). Each entry is { text, by, at }: `text` is
// PHI (patient-visible), `by` is an email principal and `at` is an ISO timestamp
// (both NON-PHI). ANYONE who can see the task may append.
//
// WHY A PLAIN .mjs (mirrors taskResult.mjs): the project's test runner is
// `node --test tests/*.test.mjs` with NO TS transpile step. Keeping the
// normalize + relative-time helpers here (React-free) lets the tests import them
// directly, and the <TaskMessagesFeed> React component is a thin wrapper over
// them. So the dispatch + fallback contract (absent/empty/malformed → render
// nothing) is fully covered by the pure tests.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Normalize a wire `messages` value into a clean, ORDER-PRESERVING array of
 * { text, by, at }. Defensive: a non-array, or entries missing a usable `text`,
 * are dropped (never thrown on). `by`/`at` degrade to '' when absent/non-string
 * so the renderer always has a string. Newest-last order is PRESERVED as-is
 * (the server returns them in order); we do not re-sort. Returns [] for
 * absent/empty/malformed input so the host renders NOTHING (NON-REGRESSION,
 * exactly like notes/result fall back).
 *
 * @param {unknown} messages
 * @returns {{ text: string, by: string, at: string }[]}
 */
export function normalizeTaskMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const text = typeof m.text === 'string' ? m.text : '';
    // A message with no text carries nothing to show — drop it (an empty-text
    // post is a 400 server-side anyway, so this only guards malformed wire data).
    if (!text) continue;
    const by = typeof m.by === 'string' ? m.by : '';
    const at = typeof m.at === 'string' ? m.at : '';
    out.push({ text, by, at });
  }
  return out;
}

/**
 * True when there is at least one well-shaped message to render. The host gates
 * the whole Messages section on this so an absent/empty/malformed feed renders
 * NOTHING (no empty heading) — the same fallback contract as notes/result.
 * @param {unknown} messages
 * @returns {boolean}
 */
export function hasTaskMessages(messages) {
  return normalizeTaskMessages(messages).length > 0;
}

/**
 * Parse an ISO/epoch `at` into ms, or NaN when unparseable. NON-PHI.
 * @param {string|number|null|undefined} at
 * @returns {number}
 */
function parseMs(at) {
  if (at == null) return NaN;
  if (typeof at === 'number') return at;
  const t = Date.parse(at);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Compact relative age for a message timestamp: "just now" / "5m ago" /
 * "3h ago" / "2d ago", or a short calendar date beyond a week. Returns '' for an
 * absent/unparseable `at` so the renderer simply omits the time. NON-PHI.
 * @param {string|number|null|undefined} at
 * @param {number} [now]
 * @returns {string}
 */
export function relativeMessageTime(at, now = Date.now()) {
  const ms = parseMs(at);
  if (Number.isNaN(ms)) return '';
  const delta = now - ms;
  // A small future skew (clocks) reads as "just now" rather than a negative age.
  if (delta < MIN) return 'just now';
  if (delta < HOUR) return `${Math.round(delta / MIN)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
