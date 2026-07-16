// task-35dde066caf7 ("Brain C5") — renders the SiteNote surface: shared
// operational notes for a domain, from BOTH the legacy chromeext store and
// the Brain's tiered, curated knowledge (electron/typebuild/site-memory.ts
// recallSiteMemoryWithBrain). Brain-sourced notes show which tier they came
// from (global/org/task) and a confidence/quality indicator; legacy notes
// render plainly (no tier concept there).
//
// Pending CANDIDATE knowledge (a memory/tool this session just proposed) is a
// SEPARATE prop, not part of the recalled `notes` list: brain_api's
// recall/get_tool only ever return ACTIVE rows (see brain-client.ts), so a
// candidate is never something you "look up" — it's only ever the id/preview
// the write call just echoed back. Auto-confirm is the default (see
// electron/typebuild/brain-confirm.ts); `pendingCandidates` is for the rarer
// case a caller explicitly wants a human to eyeball one via
// CandidateKnowledgeCard before moving on.

import { useEffect, useState } from 'react';
import { fm, type BrainSiteNote } from '../bridge';
import { TierBadge, ConfidenceBadge } from './BrainBadge';
import {
  CandidateKnowledgeCard,
  type PendingCandidateKnowledge,
} from './CandidateKnowledgeCard';
import './SiteNotesPanel.css';

export function SiteNotesPanel({
  domain,
  pendingCandidates = [],
  onCandidateResolved,
}: {
  domain: string;
  /** Candidates awaiting an explicit human confirm/reject (rare path — see
   *  file header; the common agent path auto-confirms and never populates
   *  this). */
  pendingCandidates?: PendingCandidateKnowledge[];
  onCandidateResolved?: (id: string, outcome: 'confirmed' | 'rejected') => void;
}) {
  const [notes, setNotes] = useState<BrainSiteNote[]>([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fm.brainSiteNotes(domain)
      .then((r) => {
        if (cancelled) return;
        setNotes(r.notes);
        setOffline(r.offline);
      })
      .catch(() => {
        if (cancelled) return;
        setNotes([]);
        setOffline(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [domain]);

  return (
    <div className="site-notes-panel">
      {pendingCandidates.length > 0 && (
        <div className="site-notes-panel__candidates">
          {pendingCandidates.map((c) => (
            <CandidateKnowledgeCard
              key={c.id}
              candidate={c}
              onConfirm={async (cand) => {
                // Auto-confirm's local counterpart: no server call exists to
                // make (see brain-confirm.ts) — this just acknowledges it.
                onCandidateResolved?.(cand.id, 'confirmed');
              }}
              onReject={async (cand) => {
                await fm.brainRejectCandidate(cand.id).catch(() => {});
                onCandidateResolved?.(cand.id, 'rejected');
              }}
            />
          ))}
        </div>
      )}

      {loading ? (
        <div className="site-notes-panel__empty">Loading notes for {domain}…</div>
      ) : notes.length === 0 ? (
        <div className="site-notes-panel__empty">No shared notes for {domain} yet.</div>
      ) : (
        <>
          {offline && (
            <div className="site-notes-panel__offline">
              Offline — showing the last-synced notes.
            </div>
          )}
          <ul className="site-notes-panel__list">
            {notes.map((n) => (
              <li key={n.id} className="site-notes-panel__row">
                <div className="site-notes-panel__row-head">
                  <span className="site-notes-panel__kind">{n.kind}</span>
                  <TierBadge tier={n.tier} />
                  <ConfidenceBadge score={n.confidence} level={n.confidenceLevel} />
                </div>
                <div className="site-notes-panel__body">{n.body}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
