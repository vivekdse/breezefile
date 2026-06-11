// TypeBuild MCP session-expiry clock (fm-b5at.10).
//
// The MCP JWT a TypeBuild session runs on lives ~8h and CANNOT be refreshed
// mid-session (static Authorization header, no in-session OAuth fallback). A
// session that outlives its token loses the MCP connection with an opaque
// in-terminal error — exactly what a non-technical user must never see. Since
// Breeze minted the token, it knows the exact expiry epoch (sessions.ts). This
// clock uses that to get ahead of the lapse:
//
//   - T-15min: broadcast a 'warning' so the renderer shows a quiet notice on
//     the session tab ("This task session expires soon.").
//   - At/after expiry: broadcast 'expired' so the renderer offers a friendly
//     one-click relaunch ("Your secure session expired — restart task?").
//
// Mechanics: we keep per-session timers for the two phases. setTimeout does
// NOT fire while the machine is asleep, so we ALSO (a) listen for
// powerMonitor 'resume' and (b) re-evaluate on a cheap 60s tick — either path
// immediately fires any phase whose deadline has already passed. Each phase is
// broadcast at most once per session (tracked in `fired`), so a wake that
// crosses both thresholds emits warning once and expired once, in order.
//
// SECURITY/PHI: broadcasts carry only the ptyId, the opaque taskId, and the
// expiry epoch — never a title/body. The token never touches this module.

import { BrowserWindow, powerMonitor } from 'electron';
import { listSessions } from './sessions';

/** How long before expiry we warn the user. */
const WARN_LEAD_MS = 15 * 60 * 1000;
/** Coarse re-check cadence — a safety net for timers that didn't fire (sleep)
 *  and for sessions registered after the last scan. Cheap: a map walk. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export type ExpiryPhase = 'warning' | 'expired';

type Fired = { warning: boolean; expired: boolean };

// Per-ptyId scheduled timers (so we can clear them when a session clears) and
// the set of phases already broadcast for that ptyId (so we never double-fire).
const timers = new Map<number, ReturnType<typeof setTimeout>[]>();
const fired = new Map<number, Fired>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function broadcast(
  ptyId: number,
  taskId: string,
  phase: ExpiryPhase,
  expiresAt: number,
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('typebuild:sessionExpiry', {
        ptyId,
        taskId,
        phase,
        expiresAt,
      });
    }
  }
}

function clearTimers(ptyId: number): void {
  const ts = timers.get(ptyId);
  if (ts) for (const t of ts) clearTimeout(t);
  timers.delete(ptyId);
}

// Fire a phase if its deadline has passed and it hasn't fired yet. Returns
// nothing; idempotent per (ptyId, phase).
function maybeFire(
  ptyId: number,
  taskId: string,
  expiresAt: number,
  phase: ExpiryPhase,
  deadline: number,
  now: number,
): void {
  if (now < deadline) return;
  const f = fired.get(ptyId) ?? { warning: false, expired: false };
  if (f[phase]) return;
  f[phase] = true;
  fired.set(ptyId, f);
  broadcast(ptyId, taskId, phase, expiresAt);
}

// Re-evaluate every live session: fire any already-due phase immediately, and
// (re-)arm timers for phases still in the future. Called on start, on each
// sweep tick, and on wake. Sessions that have disappeared get their timers +
// fired-state cleaned up.
function reconcile(): void {
  const now = Date.now();
  const live = new Set<number>();

  for (const s of listSessions()) {
    live.add(s.ptyId);
    const warnAt = s.expiresAt - WARN_LEAD_MS;
    // Fire anything already due (covers wake-from-sleep + late registration).
    maybeFire(s.ptyId, s.taskId, s.expiresAt, 'warning', warnAt, now);
    maybeFire(s.ptyId, s.taskId, s.expiresAt, 'expired', s.expiresAt, now);

    // (Re-)arm timers for phases still ahead. Clear first so we don't stack
    // duplicates across reconciles; already-fired phases won't re-arm because
    // their deadline is in the past (maybeFire handled them) or `fired` guards.
    clearTimers(s.ptyId);
    const f = fired.get(s.ptyId) ?? { warning: false, expired: false };
    const arm: ReturnType<typeof setTimeout>[] = [];
    if (!f.warning && warnAt > now) {
      arm.push(
        setTimeout(
          () =>
            maybeFire(
              s.ptyId,
              s.taskId,
              s.expiresAt,
              'warning',
              warnAt,
              Date.now(),
            ),
          warnAt - now,
        ),
      );
    }
    if (!f.expired && s.expiresAt > now) {
      arm.push(
        setTimeout(
          () =>
            maybeFire(
              s.ptyId,
              s.taskId,
              s.expiresAt,
              'expired',
              s.expiresAt,
              Date.now(),
            ),
          s.expiresAt - now,
        ),
      );
    }
    if (arm.length) timers.set(s.ptyId, arm);
  }

  // Drop bookkeeping for sessions that have cleared (PTY exited / relaunched).
  for (const ptyId of [...timers.keys()]) {
    if (!live.has(ptyId)) clearTimers(ptyId);
  }
  for (const ptyId of [...fired.keys()]) {
    if (!live.has(ptyId)) fired.delete(ptyId);
  }
}

/** Start the expiry clock. Idempotent. Wired once from main.ts alongside the
 *  other TypeBuild wiring. The clock is passive when no sessions are live —
 *  the sweep just walks an empty map. */
export function startExpiryClock(): void {
  if (started) return;
  started = true;

  // Wake-from-sleep: timers don't fire while suspended, so re-evaluate the
  // instant we resume — any phase whose deadline passed during sleep fires now.
  powerMonitor.on('resume', reconcile);

  // Coarse safety-net tick: catches sessions registered between reconciles and
  // any deadline a sleeping timer missed (belt-and-braces with 'resume').
  sweepTimer = setInterval(reconcile, SWEEP_INTERVAL_MS);

  // Initial pass (handles sessions that already exist at startup, e.g. a
  // restored window — rare, but free to cover).
  reconcile();
}

/** Stop the clock and clear all timers. Provided for symmetry / tests; main
 *  never stops it (the clock lives for the app's lifetime). */
export function stopExpiryClock(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  powerMonitor.removeListener('resume', reconcile);
  for (const ptyId of [...timers.keys()]) clearTimers(ptyId);
  fired.clear();
  started = false;
}

/** Force a re-evaluation. Exposed so the relaunch path (or a test) can poke
 *  the clock to re-arm immediately after a session (de)registers, rather than
 *  waiting up to SWEEP_INTERVAL_MS. */
export function reconcileExpiry(): void {
  reconcile();
}
