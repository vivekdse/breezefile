// task-35dde066caf7 ("Brain C5") — confirm/reject UI for CANDIDATE-tier brain
// knowledge (folds superseded Brain #9, task-13ac13209917).
//
// DEFAULT IS AUTO-CONFIRM: the common path is agent-driven (record_observation
// / propose_tool already writes a candidate the instant the agent captures a
// learning — see electron/typebuild/brain-confirm.ts's header), so this card
// is NOT shown on every candidate write. It renders only when a caller
// explicitly wants a human to eyeball a specific candidate before moving on —
// mirroring how src/copilot/actionKit.tsx's confirmedAction/ConfirmCard is
// used for irreversible/side-effecting actions (vs. immediateAction's silent
// auto-fire for reversible ones). Same visual language: reuses ConfirmDialog's
// .confirm__title/__body/__actions/__btn* classes so it doesn't invent a new
// look, exactly like actionKit.tsx's ConfirmCard does.
//
// WHAT CONFIRM/REJECT ACTUALLY DO (load-bearing, see brain-confirm.ts):
// brain_api has NO confirm/reject/promote HTTP endpoint today — promotion
// candidate -> active is done ONLY by the async curator (S6). So:
//   - Confirm  = "I've reviewed this, nothing to do" (no-op call — the curator
//     was always going to consider it; see autoConfirmCandidate).
//   - Reject   = client-side-only suppression (rejectCandidateLocally): we
//     remember the id locally so this card never re-offers the SAME candidate,
//     and the offline cache's active-only mirror (site-memory.ts) will never
//     have included it anyway. It does NOT delete/demote the row server-side.
// The card's copy is written to be honest about this rather than imply a
// reject actually un-writes anything upstream.

import { useState } from 'react';
import './ConfirmDialog.css';
import './CandidateKnowledgeCard.css';

export interface PendingCandidateKnowledge {
  id: string;
  kind: 'memory' | 'tool';
  /** Short NON-PHI preview of the body/code just proposed. */
  preview: string;
  domain?: string | null;
}

export function CandidateKnowledgeCard({
  candidate,
  onConfirm,
  onReject,
}: {
  candidate: PendingCandidateKnowledge;
  /** Called on Confirm. Local-only bookkeeping (see file header) — resolves
   *  quickly, no server round-trip required. */
  onConfirm: (candidate: PendingCandidateKnowledge) => void | Promise<void>;
  /** Called on Reject. Should call brainRejectCandidate/rejectCandidateLocally
   *  so the same candidate doesn't resurface. */
  onReject: (candidate: PendingCandidateKnowledge) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [done, setDone] = useState<'confirmed' | 'rejected' | null>(null);

  async function confirm() {
    if (busy || done) return;
    setBusy('confirm');
    try {
      await onConfirm(candidate);
      setDone('confirmed');
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (busy || done) return;
    setBusy('reject');
    try {
      await onReject(candidate);
      setDone('rejected');
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="candidate-card candidate-card--done">
        <div className="confirm__body">
          {done === 'confirmed'
            ? 'Left for the curator to review as usual.'
            : "Won't ask about this one again."}
        </div>
      </div>
    );
  }

  return (
    <div className="candidate-card">
      <div className="confirm__title">
        New {candidate.kind === 'tool' ? 'tool' : 'memory'} candidate
        {candidate.domain ? ` for ${candidate.domain}` : ''}
      </div>
      <div className="confirm__body candidate-card__preview">{candidate.preview}</div>
      <p className="candidate-card__note">
        This is CANDIDATE-tier — the curator promotes it to active on its own
        schedule. Confirm just acknowledges it; Reject stops it from being
        shown here again (it does not delete anything already recorded).
      </p>
      <div className="confirm__actions">
        <button
          type="button"
          className="confirm__btn confirm__btn--cancel"
          disabled={busy !== null}
          onClick={() => void reject()}
        >
          {busy === 'reject' ? 'Working…' : 'Reject'}
        </button>
        <button
          type="button"
          className="confirm__btn confirm__btn--primary"
          disabled={busy !== null}
          onClick={() => void confirm()}
        >
          {busy === 'confirm' ? 'Working…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
