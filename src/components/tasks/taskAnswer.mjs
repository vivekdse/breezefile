// task-a763ca5be676 — pure helpers for the inline "answer a pending question"
// reply box. Runtime is plain ESM so the node test runner imports it without a
// transpile step (mirrors taskMessages.mjs). NO React, NO PHI persistence — the
// question text + the typed answer live only in the component's React state.

/** The trimmed answer a submit would send, or '' when there is nothing to send.
 *  Centralized so the row + drawer share ONE definition of "what gets sent". */
export function normalizeAnswer(draft) {
  return typeof draft === 'string' ? draft.trim() : '';
}

/** Whether a submit should be allowed: a non-empty trimmed answer and not
 *  already in flight. Drives the Send button's disabled state + the Enter
 *  handler's early-return, so they never disagree. */
export function canSubmitAnswer(draft, submitting) {
  return !submitting && normalizeAnswer(draft).length > 0;
}

/** The quick-reply option chips to render: the pending question's `options`
 *  when it's a non-empty array of non-empty strings, else []. An empty result
 *  means "no chips" — the box shows just the free-text input. Defensive so a
 *  malformed server payload can never crash the row. */
export function answerOptions(pendingQuestion) {
  const opts = pendingQuestion && pendingQuestion.options;
  if (!Array.isArray(opts)) return [];
  return opts.filter((o) => typeof o === 'string' && o.trim().length > 0);
}
