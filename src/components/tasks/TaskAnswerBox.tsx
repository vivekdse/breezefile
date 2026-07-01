// task-a763ca5be676 — the shared INLINE "answer a pending question" reply box.
// One affordance used in TWO places: expanded under a task ROW (click the `?`
// badge / the question subtitle) and pinned at the TOP of the detail DRAWER.
//
// It renders a free-text input (Enter submits) plus one quick-reply CHIP per
// `pending_question.options` entry (clicking a chip submits that option as the
// answer). On success it calls onAnswered() so the caller refreshes — the
// answered task then drops out of the `asked` bucket + hero. On failure it
// surfaces the reason INLINE and keeps the draft.
//
// PHI: the question text and the typed/selected answer are patient-visible. They
// live ONLY in React state here — never logged, never persisted. The answer is
// sent to the server via answerTaskQuestion (the request helper never logs
// bodies). The draft is dropped on unmount / task change by the parent's keying.

import { useState } from 'react';
import { answerTaskQuestion, markQuestionAnswered } from '../../tasks';
import { formatSourceReason, formatOpError } from '../../errorMessages';
import {
  answerOptions,
  canSubmitAnswer,
  normalizeAnswer,
} from './taskAnswer.mjs';
import type { PendingQuestion } from './taskAnswer.d.mts';

export function TaskAnswerBox({
  taskId,
  pendingQuestion,
  autoFocus = false,
  onAnswered,
  onCancel,
}: {
  taskId: string;
  pendingQuestion: PendingQuestion;
  /** Focus the text input on mount (row expansion wants this; the pinned
   *  drawer card leaves focus alone). */
  autoFocus?: boolean;
  /** Called after a successful answer so the caller refreshes the list/detail
   *  (the answered task drops out of the asked bucket). */
  onAnswered: () => void;
  /** Optional dismiss (the row's inline box offers a Cancel/close). */
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = answerOptions(pendingQuestion);

  // Submit a specific answer (a typed reply OR a chosen option). Shared by the
  // text input and the option chips so both go through the same success/error
  // handling. `raw` is the exact answer to send (already the option string for
  // a chip; the current draft for the input).
  const submit = async (raw: string) => {
    const answer = normalizeAnswer(raw);
    if (!answer || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await answerTaskQuestion(taskId, answer);
      if (res.ok) {
        setDraft('');
        // Optimistically clear the question across every live task list so the
        // answered task drops out of the asked bucket + hero immediately, even
        // before the caller's onAnswered() (and before the 30s poll catches up).
        markQuestionAnswered(taskId);
        onAnswered();
      } else {
        setError(formatSourceReason(res.reason));
      }
    } catch (e) {
      setError(formatOpError('send answer', e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="task-answer"
      // The box lives inside clickable row/card surfaces; keep its own clicks
      // from bubbling into a row-select or drawer-tab change.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="task-answer__row">
        <input
          type="text"
          className="task-answer__input"
          placeholder="Type your answer…"
          value={draft}
          disabled={submitting}
          autoFocus={autoFocus}
          aria-label="Your answer"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit(draft);
            } else if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className="task-answer__send"
          disabled={!canSubmitAnswer(draft, submitting)}
          onClick={() => void submit(draft)}
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
        {onCancel && (
          <button
            type="button"
            className="task-answer__cancel"
            aria-label="Cancel"
            title="Cancel"
            disabled={submitting}
            onClick={onCancel}
          >
            ✕
          </button>
        )}
      </div>
      {options.length > 0 && (
        <div className="task-answer__chips">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="task-answer__chip"
              disabled={submitting}
              onClick={() => void submit(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="task-answer__error" role="alert">
          Couldn’t send · {error}
        </div>
      )}
    </div>
  );
}
