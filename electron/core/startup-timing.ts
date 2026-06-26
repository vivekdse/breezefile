// Cold-start timing instrumentation (fm-ued6).
//
// Lightweight, zero-dependency boot profiler for diagnosing the sluggish
// window right after launch. It records named marks against a single monotonic
// clock (process start) and prints a sorted timeline once the renderer reports
// its first interactive frame (or on a fallback timer).
//
// DESIGN / KEEP-OR-REMOVE:
//   - Behind a flag: enabled only when BREEZE_STARTUP_PROFILE=1 (or in dev,
//     where the extra logging is harmless). Off by default in production, so
//     this can stay in the tree without taxing normal launches.
//   - One log namespace: every line is tagged `[startup]` so it greps cleanly
//     and is trivially removed later (`git grep "\[startup\]"`).
//   - NON-PHI: it only ever logs phase names + millisecond deltas. Never task
//     content, paths, tokens, or user data.
//
// Usage:
//   import { mark, timeSync, timeAsync, dumpTimeline } from './core/startup-timing';
//   mark('main:whenReady');
//   timeSync('boot:registerIpc', () => registerIpc());
//   // renderer posts 'app:firstPaint' → main calls dumpTimeline()

const ENABLED =
  process.env.BREEZE_STARTUP_PROFILE === '1' ||
  process.env.NODE_ENV === 'development' ||
  !!process.env.VITE_DEV_SERVER_URL;

const NS = '[startup]';

type Mark = { name: string; at: number };

// process.uptime() is seconds since the Node process spawned — the closest
// cheap proxy we have to "process spawn" inside the main process. We convert to
// ms and treat the module-load instant as the t0 reference for deltas. Electron's
// own pre-main work (binary load, V8 init) happens before this module loads and
// is therefore NOT captured here — see report notes.
function nowMs(): number {
  // uptime is high-resolution and monotonic; multiply to ms.
  return Math.round(process.uptime() * 1000);
}

const T0 = nowMs();

const marks: Mark[] = [];
let dumped = false;

/** Record a single instantaneous phase marker. No-op when profiling is off. */
export function mark(name: string): void {
  if (!ENABLED) return;
  marks.push({ name, at: nowMs() });
}

/** Time a synchronous block: records the block's wall-clock duration and
 *  returns its value. Pass-through (no try/catch) so errors still propagate
 *  exactly as before. */
export function timeSync<T>(name: string, fn: () => T): T {
  if (!ENABLED) return fn();
  const start = nowMs();
  const out = fn();
  const dur = nowMs() - start;
  marks.push({ name: `${name} (+${dur}ms)`, at: start });
  return out;
}

/** Time an async block. Same contract as timeSync but awaits the promise. */
export async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!ENABLED) return fn();
  const start = nowMs();
  const out = await fn();
  const dur = nowMs() - start;
  marks.push({ name: `${name} (+${dur}ms)`, at: start });
  return out;
}

/** Print the ordered timeline with per-step deltas. Idempotent — only the
 *  first call prints (later first-paint duplicates / the fallback timer are
 *  ignored). NON-PHI: names + ms only. */
export function dumpTimeline(trigger = 'manual'): void {
  if (!ENABLED || dumped) return;
  dumped = true;
  mark(`timeline:dump (${trigger})`);
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  // eslint-disable-next-line no-console
  console.log(`${NS} ── cold-start timeline (t0 = module load @ ${T0}ms uptime) ──`);
  let prev = T0;
  for (const m of sorted) {
    const sinceStart = m.at - T0;
    const sincePrev = m.at - prev;
    prev = m.at;
    // eslint-disable-next-line no-console
    console.log(
      `${NS} ${String(sinceStart).padStart(6)}ms (+${String(sincePrev).padStart(5)}ms)  ${m.name}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`${NS} ── end timeline (${sorted.length} marks) ──`);
}

/** True when profiling is on, so callers can guard extra work. */
export function startupProfilingEnabled(): boolean {
  return ENABLED;
}
