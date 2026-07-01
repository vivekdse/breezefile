// task-da23979fd907 — type surface for the pure taskMessages.mjs module (runtime
// is plain ESM so the node test runner imports it without a transpile step).

/** One entry in the USER-facing, append-only task message feed. `text` is PHI
 *  (patient-visible); `by` (email principal) + `at` (ISO timestamp) are NON-PHI. */
export type TaskMessage = { text: string; by: string; at: string };

export function normalizeTaskMessages(messages: unknown): TaskMessage[];

export function hasTaskMessages(messages: unknown): boolean;

export function relativeMessageTime(
  at: string | number | null | undefined,
  now?: number,
): string;
