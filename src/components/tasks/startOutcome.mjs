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
  // task-6fc9e503623e — the child spawned but exited within the liveness
  // grace window. The exit-code detail rides in the message tail (see below).
  'early-exit': 'the session exited immediately',
};

/**
 * @param {unknown} err
 * @returns {string|null}
 */
export function launchErrorReason(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /\[typebuild-launch:([a-z-]+)\]/.exec(raw);
  if (!m) return null;
  const base = LAUNCH_MESSAGES[m[1]] ?? `launch failed (${m[1]})`;
  // task-6fc9e503623e — preserve the "(exit N)" detail the source appended to
  // an early-exit message so the row/status line names the exit code, not just
  // "exited immediately". The rest of the message (after the tag) is the
  // human-readable detail; pull an "(exit …)" clause if present.
  const detail = /\(exit [^)]*\)/.exec(raw);
  return detail ? `${base} ${detail[0]}` : base;
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

/**
 * task-6fc9e503623e — classify a PTY LIVENESS verdict (from the electron
 * launcher's `awaitPtyLiveness`) into the Start decision the source acts on.
 * This mirrors, in a pure/testable form, the gate electron/sources/typebuild.ts
 * applies after runTaskInteractive returns:
 *
 *   - alive:true  → started. The session stayed up (or emitted first output).
 *   - alive:false → EARLY EXIT. The child spawned but died within the grace
 *                   window; the source must release the claim and record the
 *                   exit code + tail. We build the machine-tagged reason string
 *                   here so both the throw and the recorded note carry the same
 *                   exit-code detail (`[typebuild-launch:early-exit] … (exit N)`).
 *
 * @param {{ alive: boolean, exitCode: number|null, signal: number|null, tail?: string }} verdict
 * @returns {{ alive: true } | { alive: false, exitCode: number|null, taggedError: string, note: string }}
 */
export function classifyLiveness(verdict) {
  if (verdict && verdict.alive) return { alive: true };
  const exitCode = verdict && verdict.exitCode != null ? verdict.exitCode : null;
  const codeLabel = exitCode == null ? 'null' : String(exitCode);
  const tail = verdict && typeof verdict.tail === 'string' ? verdict.tail.trim() : '';
  return {
    alive: false,
    exitCode,
    taggedError: `[typebuild-launch:early-exit] claude exited immediately (exit ${codeLabel})`,
    note:
      `Auto-start session exited immediately (exit ${codeLabel})` +
      (tail ? `\n---\n${tail}` : ''),
  };
}
