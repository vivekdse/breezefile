// task-3f0c6a6abe41 — type surface for the pure startOutcome.mjs module
// (runtime is plain ESM so `node --test` imports it without a transpile step).

/** Map a thrown [typebuild-launch:<code>] Error to a terse reason, or null. */
export function launchErrorReason(err: unknown): string | null;

/** Map a thrown [typebuild-mint:<code>] Error to its in-app message, or null. */
export function mintErrorReason(err: unknown): string | null;

export function spawnedOutcome(
  source: string | undefined,
  res: { ok?: boolean; ptyId?: number } | null | undefined,
): { spawned: boolean; ptyId: number | undefined; needsPtyThrow: boolean };

/** task-6fc9e503623e — classify a PTY liveness verdict into the Start
 *  decision the source acts on (alive → started; early exit → release + record
 *  with the exit-code tagged error + note). */
export function classifyLiveness(
  verdict: {
    alive: boolean;
    exitCode: number | null;
    signal: number | null;
    tail?: string;
  },
): { alive: true } | { alive: false; exitCode: number | null; taggedError: string; note: string };
