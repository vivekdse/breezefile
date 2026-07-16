// task-cc9a4ef6f38a — HeroStats: the stat-card grid (spec §1) that drives the
// Project View's primary status filter. Each card is a toggle: clicking the
// active card resets the filter to 'all'; clicking any other card selects that
// status. Colors route through the shared --nh-* status vars (see .nh in
// NewHomePage.css) via the left-border treatment from the V11 design reference.
import type { NewHomeStatus } from './types';
import { STATUS_LABELS } from './rosterGroups.mjs';
import './HeroStats.css';

// task-c0edffef25c6 — 'cancelled' deliberately has no card here: the hero grid
// stays the 6-up needs/open/progress/scheduled/failed/done layout, and a
// cancelled task is reachable via "All" rather than its own stat/filter.
// LABELS must still be exhaustive over NewHomeStatus (the shared counts
// record carries a cancelled tally now), so it needs the entry even though
// ORDER never renders it.
//
// ORDER leads with the work that demands attention and trails with the record
// of what's finished. Done used to sit in the leftmost slot wearing a green
// accent, so the eye landed on completed work — but the number a user opens
// this page for is what's still PENDING, not what's already handled.
const ORDER: NewHomeStatus[] = ['needs', 'open', 'progress', 'scheduled', 'failed', 'done'];

// The buckets that are asking for something. These carry the visual weight —
// but only when they actually have a count: "0 Needs You" is good news and
// should recede, not shout. 'scheduled' and 'progress' are excluded because
// they're already in hand (a clock or an agent has them); 'done' is excluded
// because it's a record, not a call to action.
const ATTENTION: ReadonlySet<NewHomeStatus> = new Set<NewHomeStatus>(['needs', 'open', 'failed']);

// task-ea465f2c5964 — was a second hand-maintained copy of the label map
// (alongside RosterTable's STATUS_LABEL and TaskMatrix's inline pill labels);
// now re-exported from rosterGroups.mjs's single STATUS_LABELS.
const LABELS: Record<NewHomeStatus, string> = STATUS_LABELS;

/** Which of the three weights a card renders at.
 *  'urgent' — an attention bucket with work in it: full accent ink, biggest
 *             numeral, thickest rule.
 *  'quiet'  — 'done' (always: a record, never a call to action) and ANY empty
 *             card, which has nothing to say.
 *  'base'   — live-but-handled work (progress/scheduled with a count). */
function emphasisFor(s: NewHomeStatus, count: number): 'urgent' | 'quiet' | 'base' {
  if (s === 'done' || count === 0) return 'quiet';
  return ATTENTION.has(s) ? 'urgent' : 'base';
}

export function HeroStats({
  counts,
  activeFilter,
  onFilter,
}: {
  counts: Record<NewHomeStatus, number>;
  activeFilter: 'all' | NewHomeStatus;
  onFilter: (f: 'all' | NewHomeStatus) => void;
}) {
  return (
    <div className="nh-hero-stats">
      <div className="nh-hero-stats__grid">
        {ORDER.map((s) => {
          const isActive = activeFilter === s;
          const emphasis = emphasisFor(s, counts[s]);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={isActive}
              className={`nh-hero-stats__stat nh-hero-stats__stat--${s} nh-hero-stats__stat--${emphasis}${
                isActive ? ' nh-hero-stats__stat--active' : ''
              }`}
              onClick={() => onFilter(isActive ? 'all' : s)}
            >
              <div className="nh-hero-stats__label">{LABELS[s]}</div>
              <div className="nh-hero-stats__value">{counts[s]}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
