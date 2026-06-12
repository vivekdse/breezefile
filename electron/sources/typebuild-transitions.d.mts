// fm-h8g7 — type surface for the pure typebuild-transitions.mjs module (runtime
// is plain ESM so the node test runner can import it without a transpile step).

/** A minimal routing-only row. NEVER carries titles/bodies (PHI). */
export interface TransitionRow {
  id: string;
  status?: string;
  rawStatus?: string;
  claimedBy?: string | null;
}

export type TransitionKind =
  | 'new'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'claim-lost';

export interface Transition {
  taskId: string;
  kind: TransitionKind;
}

export function classifyTransitions(
  prevRows: TransitionRow[],
  freshRows: TransitionRow[],
  myEmail: string | null,
  isFirstPoll: boolean,
): Transition[];
