// task-15d78a7feee2 — Approval Bar: the amber collapsible strip at the top of
// New Home surfacing every task blocked on a human answer. Layout/interaction
// adapted from the V11 design reference's `.approval-bar` block (see task
// body for path), recolored onto the app's --nh-needs* tokens.
//
// Ownership note: this file + ApprovalBar.css are the ONLY files this task
// touches. `types.ts` / `useNewHomeData.ts` / `NewHomePage.tsx` are owned by
// other in-flight work — any derived value this bar needs but doesn't have on
// NewHomeTask is computed locally from `task.raw` / `task.pendingQuestion`
// below rather than requesting a contract change.
//
// PHI: task titles + pending-question text render in memory only — never
// logged/persisted (see docs/typebuild-data-field-contract.md). The answer
// submission path reuses answerTaskQuestion/markQuestionAnswered from
// src/tasks.ts, the same plumbing TaskAnswerBox uses, so PHI handling stays
// identical across both surfaces.

import { useState } from 'react';
import type { NewHomeTask } from './types';
import { answerTaskQuestion, markQuestionAnswered } from '../../tasks';
import { formatSourceReason, formatOpError } from '../../errorMessages';
import { answerOptions, canSubmitAnswer, normalizeAnswer } from '../tasks/taskAnswer.mjs';
import './ApprovalBar.css';

// A task waiting longer than this on a pending question counts as "urgent"
// for the default-expanded rule below. No urgency signal exists yet on the
// task itself (TODO(New Home follow-up): promote a real `waitingSince` onto
// NewHomeTask once other stubs need it too) — derived here from whatever
// timestamp is available on the raw task / pending question.
const URGENT_WAIT_MS = 60 * 60 * 1000; // 1 hour

const AFFIRMATIVE_RE = /^(yes|approve|ok|confirm)/i;
const NEGATIVE_RE = /^(no|reject|cancel|deny)/i;

function waitingSinceIso(t: NewHomeTask): string | null {
  return t.pendingQuestion?.asked_at ?? t.raw.updatedAtIso ?? t.raw.createdAtIso ?? null;
}

function isUrgent(t: NewHomeTask, now: number): boolean {
  const iso = waitingSinceIso(t);
  if (!iso) return false; // no timestamp signal — treat as non-urgent, per spec.
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return false;
  return now - ts >= URGENT_WAIT_MS;
}

/** The single option a bulk "Approve selected" pass should submit for a task,
 *  or undefined when the choice is ambiguous (multiple non-affirmative
 *  options) and the card must be skipped. */
function singleAffirmativeOption(options: string[]): string | undefined {
  if (options.length === 1) return options[0];
  const matches = options.filter((o) => AFFIRMATIVE_RE.test(o.trim()));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The answer text the Cancel/Reject button sends: reuse a matching negative
 *  option if the question offered one, else fall back to a literal. */
function rejectAnswer(options: string[]): string {
  const neg = options.find((o) => NEGATIVE_RE.test(o.trim()));
  return neg ?? 'Reject';
}

export function ApprovalBar({
  approvals,
  onOpenTask,
  onResolved,
}: {
  approvals: NewHomeTask[];
  onOpenTask: (id: string) => void;
  onResolved: (id: string) => void;
}) {
  // Default expand/collapse is computed once from the approvals this bar
  // first mounts with; after that the user's toggle wins. Re-deriving this on
  // every approvals change would fight a manual collapse each time a card
  // resolves.
  const [expanded, setExpanded] = useState(() => {
    const now = Date.now();
    return approvals.length > 3 || approvals.some((t) => isUrgent(t, now));
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submittingIds, setSubmittingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  const setSubmitting = (id: string, on: boolean) => {
    setSubmittingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const clearError = (id: string) => {
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Shared submit path for a single card — quick-reply option, free-text
  // answer, or the Cancel/Reject button all funnel through here so success +
  // failure handling never drifts between the three. Mirrors
  // TaskAnswerBox.submit (src/components/tasks/TaskAnswerBox.tsx).
  const submitAnswer = async (taskId: string, raw: string) => {
    const answer = normalizeAnswer(raw);
    if (!answer || submittingIds.has(taskId)) return;
    setSubmitting(taskId, true);
    clearError(taskId);
    try {
      const res = await answerTaskQuestion(taskId, answer);
      if (res.ok) {
        markQuestionAnswered(taskId);
        setSelected((prev) => {
          if (!prev.has(taskId)) return prev;
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
        onResolved(taskId);
      } else {
        setErrors((prev) => ({ ...prev, [taskId]: formatSourceReason(res.reason) }));
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [taskId]: formatOpError('send answer', e) }));
    } finally {
      setSubmitting(taskId, false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableIds = approvals.map((t) => t.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  };

  const approveSelected = async () => {
    setBulkSubmitting(true);
    setBulkNote(null);
    let skipped = 0;
    for (const t of approvals) {
      if (!selected.has(t.id)) continue;
      const opt = singleAffirmativeOption(answerOptions(t.pendingQuestion));
      if (!opt) {
        skipped += 1;
        continue;
      }
      // Sequential on purpose — each submit optimistically mutates shared
      // task-list state (markQuestionAnswered); firing them concurrently adds
      // no real speedup here and keeps error attribution simple.
      await submitAnswer(t.id, opt);
    }
    setBulkSubmitting(false);
    setBulkNote(
      skipped > 0
        ? `${skipped} skipped — needs manual review (no single clear approve option)`
        : null,
    );
  };

  const count = approvals.length;

  return (
    <div className={`nh-approval-bar${expanded ? ' nh-approval-bar--expanded' : ''}`}>
      <div
        className="nh-approval-bar__summary"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div className="nh-approval-bar__summary-left">
          <span className="nh-approval-bar__count-dot">{count}</span>
          <span>item{count === 1 ? '' : 's'} need your approval</span>
        </div>
        <div className="nh-approval-bar__summary-right">
          <span className="nh-approval-bar__hint">Click to review</span>
          <span className="nh-approval-bar__chevron" aria-hidden="true">
            ▾
          </span>
        </div>
      </div>

      {expanded && (
        <div className="nh-approval-bar__cards">
          {approvals.map((t) => (
            <ApprovalCard
              key={t.id}
              task={t}
              selected={selected.has(t.id)}
              submitting={submittingIds.has(t.id)}
              error={errors[t.id] ?? null}
              onToggleSelect={() => toggleSelected(t.id)}
              onOpenTask={() => onOpenTask(t.id)}
              onSubmit={(answer) => void submitAnswer(t.id, answer)}
              onReject={() => void submitAnswer(t.id, rejectAnswer(answerOptions(t.pendingQuestion)))}
            />
          ))}

          <div className="nh-approval-bar__bulk-row">
            <label className="nh-approval-bar__bulk-check">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={bulkSubmitting}
                onChange={toggleSelectAll}
              />
              Select all
            </label>
            <div className="nh-approval-bar__bulk-actions">
              {bulkNote && <span className="nh-approval-bar__bulk-note">{bulkNote}</span>}
              <button
                type="button"
                className="nh-approval-bar__btn nh-approval-bar__btn--success"
                disabled={bulkSubmitting || selected.size === 0}
                onClick={() => void approveSelected()}
              >
                {bulkSubmitting ? 'Approving…' : 'Approve selected'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  task,
  selected,
  submitting,
  error,
  onToggleSelect,
  onOpenTask,
  onSubmit,
  onReject,
}: {
  task: NewHomeTask;
  selected: boolean;
  submitting: boolean;
  error: string | null;
  onToggleSelect: () => void;
  onOpenTask: () => void;
  onSubmit: (answer: string) => void;
  onReject: () => void;
}) {
  const [draft, setDraft] = useState('');
  const options = answerOptions(task.pendingQuestion);

  const send = (raw: string) => {
    if (!canSubmitAnswer(raw, submitting)) return;
    onSubmit(raw);
    setDraft('');
  };

  return (
    <div className="nh-approval-bar__card">
      <div className="nh-approval-bar__card-head">
        <input
          type="checkbox"
          className="nh-approval-bar__card-check"
          checked={selected}
          disabled={submitting}
          onChange={onToggleSelect}
          aria-label={`Select ${task.title}`}
        />
        <div className="nh-approval-bar__card-body">
          <div className="nh-approval-bar__card-title">{task.title}</div>
          {task.pendingQuestion && (
            <div className="nh-approval-bar__card-context">{task.pendingQuestion.text}</div>
          )}
        </div>
        <button type="button" className="nh-approval-bar__jump" onClick={onOpenTask}>
          Jump to task →
        </button>
      </div>

      <div className="nh-approval-bar__card-actions">
        {options.length > 0 ? (
          options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="nh-approval-bar__btn nh-approval-bar__btn--success"
              disabled={submitting}
              onClick={() => send(opt)}
            >
              {opt}
            </button>
          ))
        ) : (
          <>
            <input
              type="text"
              className="nh-approval-bar__text-input"
              placeholder="Type your answer…"
              value={draft}
              disabled={submitting}
              aria-label="Your answer"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            <button
              type="button"
              className="nh-approval-bar__btn nh-approval-bar__btn--success"
              disabled={!canSubmitAnswer(draft, submitting)}
              onClick={() => send(draft)}
            >
              {submitting ? 'Sending…' : 'Send'}
            </button>
          </>
        )}
        <button
          type="button"
          className="nh-approval-bar__btn nh-approval-bar__btn--danger"
          disabled={submitting}
          onClick={onReject}
        >
          Cancel
        </button>
      </div>

      {error && (
        <div className="nh-approval-bar__card-error" role="alert">
          Couldn’t send · {error}
        </div>
      )}
    </div>
  );
}
