// task-a763ca5be676 — type surface for the pure taskAnswer.mjs module (runtime
// is plain ESM so the node test runner imports it without a transpile step).

/** A task's pending question as carried on the task (text is PHI, kept in
 *  memory only; options/asked_by/asked_at are NON-PHI). */
export type PendingQuestion = {
  text: string;
  options?: string[];
  asked_by?: string;
  asked_at?: string;
};

export function normalizeAnswer(draft: unknown): string;

export function canSubmitAnswer(draft: unknown, submitting: boolean): boolean;

export function answerOptions(
  pendingQuestion: { options?: unknown } | null | undefined,
): string[];
