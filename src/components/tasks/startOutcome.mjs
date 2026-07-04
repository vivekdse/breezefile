// task-3f0c6a6abe41 — PURE, testable helpers for the "did Start actually spawn
// a session?" decision + the launch/mint failure reason mapping. Split out of
// useTaskActions.ts (a React hook, not unit-testable under `node --test`) so
// the correctness-critical logic — "a typebuild start is only SPAWNED when a
// real pty id came back; anything else is a phantom to release + surface" —
// can be asserted directly. No React / IPC / DOM.
//
// The co-located startOutcome.d.mts types it for the TS hook consumer.

/** @typedef {import('../../types').Task} Task */

// task-3f0c6a6abe41 — map a thrown TypeBuild LAUNCH failure (the half AFTER
// the claim: window/pty spawn) to a terse human reason. The typed code rides
// in the Error message as "[typebuild-launch:<code>]" (IPC strips custom Error
// props). Returns null for anything that isn't a tagged launch error.
const LAUNCH_MESSAGES = {
  'no-window': 'no open Breeze window to host the session',
  'no-pty': 'the session process never started',
};

/**
 * @param {unknown} err
 * @returns {string|null}
 */
export function launchErrorReason(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-launch:([a-z-]+)\]/.exec(raw);
  if (!m) return null;
  return LAUNCH_MESSAGES[m[1]] ?? `launch failed (${m[1]})`;
}

// fm-b5at.9 — the three MCP-token mint failure messages, keyed by the code
// encoded as "[typebuild-mint:<code>]".
const MINT_MESSAGES = {
  'signed-out': 'Please sign in again',
  unreachable: "Can't reach TypeBuild right now",
  'access-denied': 'Your access has changed, contact your admin',
};

/**
 * @param {unknown} err
 * @returns {string|null}
 */
export function mintErrorReason(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-mint:([a-z-]+)\]/.exec(raw);
  if (!m) return null;
  return MINT_MESSAGES[m[1]] ?? null;
}

/**
 * Decide whether a runNow result represents a REAL spawned session.
 *
 * The correctness bar (task-c141c7765aa4 / task-3f0c6a6abe41): a typebuild
 * start is only genuinely spawned when a real (truthy) pty id came back. A
 * `{ ok:true }` with no pty id is exactly the phantom claim we must never
 * report as success — the caller treats a non-spawned result as a launch
 * failure (release the claim + surface the reason + roll the UI back).
 *
 * Local (non-typebuild) runs have no pty-id contract at this layer, so we
 * don't gate them on a pty id — a resolved run is a success.
 *
 * @param {string|undefined} source   task.source
 * @param {{ ok?: boolean, ptyId?: number } | null | undefined} res
 * @returns {{ spawned: boolean, ptyId: number|undefined, needsPtyThrow: boolean }}
 *   `spawned` — a real session exists; `ptyId` — its id (undefined for local);
 *   `needsPtyThrow` — true when this is a typebuild success WITHOUT a pty id
 *   (a phantom the caller must convert into a launch failure).
 */
export function spawnedOutcome(source, res) {
  const ptyId = res && typeof res === 'object' && 'ptyId' in res ? res.ptyId : undefined;
  if (source === 'typebuild') {
    const hasPty = typeof ptyId === 'number' && ptyId > 0;
    return { spawned: hasPty, ptyId: hasPty ? ptyId : undefined, needsPtyThrow: !hasPty };
  }
  // Local / other sources: a resolved (non-{ok:false}) result is a success.
  return { spawned: true, ptyId, needsPtyThrow: false };
}
