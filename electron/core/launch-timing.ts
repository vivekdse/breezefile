// Launch-latency timing probes (task fix/launch-latency-debug, 2026-07-05).
//
// Appends `<ISO ts> +<ms since launch start> <label>` lines to a debug log so we
// can see WHERE a slow task-start / Home-load spends its time. Flag-gated: writes
// only when BREEZE_LAUNCH_TIMING=1 (or in dev). Off in production by default.
//
// PHI: labels are hand-written and MUST contain only phase names, durations, and
// opaque task IDs — NEVER titles, bodies, or resolved data values. Callers pass
// short-id'd or id-only labels.
//
// To strip these probes later: grep the tree for `launchTiming` /
// `import ... launch-timing`.

import { appendFileSync } from 'node:fs';

const LOG_PATH = '/tmp/breeze-launch-timing.log';

function enabled(): boolean {
  return process.env.BREEZE_LAUNCH_TIMING === '1' || !process.env.BREEZE_PACKAGED;
}

// Named epochs so "+ms since start" is meaningful per flow. A flow (e.g. a task
// launch) calls startTiming(flow) then timing(flow, label) repeatedly.
const epochs = new Map<string, number>();

/** Begin (or restart) a timing flow; returns the epoch ms. */
export function startTiming(flow: string): number {
  const t = Date.now();
  epochs.set(flow, t);
  write(flow, t, 'START');
  return t;
}

/** Record a labeled probe within a flow. */
export function timing(flow: string, label: string): void {
  write(flow, Date.now(), label);
}

function write(flow: string, now: number, label: string): void {
  if (!enabled()) return;
  const start = epochs.get(flow) ?? now;
  const line = `${new Date(now).toISOString()} +${String(now - start).padStart(6)}ms [${flow}] ${label}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    /* best-effort debug log — never let instrumentation break a launch */
  }
}
