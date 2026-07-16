// task-35dde066caf7 ("Brain C5") — small display components for the Brain's
// tiered, curated knowledge on the SiteNote surface:
//   <TierBadge>       — which of the 3 isolation tiers a note/tool came from
//                        (global / org / task — see electron/typebuild/
//                        brain-client.ts BrainTier).
//   <ConfidenceBadge> — a compact quality indicator derived from the brain's
//                       scoring fields (hit_rate, downstream_success_rate,
//                       staleness_score, composite_score).
//
// Styled as small text pills, matching TaskIndicators.tsx's convention of a
// short badge over a raw number in list rows (see TaskAttentionBadge there).
// NON-PHI: tier names + a 0-1 score, nothing else.

import './BrainBadge.css';

export type BrainTierValue = 'global' | 'org' | 'task';
export type BrainConfidenceLevel = 'high' | 'medium' | 'low';

const TIER_SHORT: Record<BrainTierValue, string> = {
  global: 'Global',
  org: 'Org',
  task: 'Task',
};

const TIER_DESC: Record<BrainTierValue, string> = {
  global: 'Shared across every business on the network',
  org: 'Scoped to your organization only',
  task: 'Scoped to this task/run only',
};

/** A small pill naming the tier a piece of brain knowledge came from. Renders
 *  nothing for an unrecognized/missing tier (e.g. a legacy chromeext note
 *  with no tier concept) so callers can render it unconditionally. */
export function TierBadge({
  tier,
  className = '',
}: {
  tier?: BrainTierValue | string | null;
  className?: string;
}) {
  if (tier !== 'global' && tier !== 'org' && tier !== 'task') return null;
  return (
    <span
      className={['brain-badge', `brain-badge--tier-${tier}`, className].filter(Boolean).join(' ')}
      title={TIER_DESC[tier]}
    >
      {TIER_SHORT[tier]}
    </span>
  );
}

const CONFIDENCE_LABEL: Record<BrainConfidenceLevel, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

/** A compact confidence/quality dot + label, keyed off a 0-1 score (see
 *  electron/typebuild/brain-client.ts confidenceScore/confidenceLevel — the
 *  SAME bucketing is replicated here so a pure-renderer component doesn't need
 *  to import the main-process module). Renders nothing when no score is known
 *  (undefined) rather than implying false confidence. */
export function ConfidenceBadge({
  score,
  level,
  className = '',
}: {
  /** 0-1 raw score, shown in the tooltip for anyone who wants the number. */
  score?: number;
  /** Precomputed bucket (electron/typebuild/brain-client.ts confidenceLevel).
   *  If omitted, derived from `score` using the same thresholds. */
  level?: BrainConfidenceLevel;
  className?: string;
}) {
  if (score === undefined && level === undefined) return null;
  const bucket: BrainConfidenceLevel =
    level ?? (score! >= 0.7 ? 'high' : score! >= 0.4 ? 'medium' : 'low');
  const pct = score !== undefined ? `${Math.round(score * 100)}%` : '';
  const title = pct ? `${CONFIDENCE_LABEL[bucket]} (${pct})` : CONFIDENCE_LABEL[bucket];
  return (
    <span
      className={['brain-badge', `brain-badge--conf-${bucket}`, className].filter(Boolean).join(' ')}
      title={title}
    >
      <span className="brain-badge__dot" aria-hidden="true" />
      {CONFIDENCE_LABEL[bucket]}
    </span>
  );
}
