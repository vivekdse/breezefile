// Shared timeout-bounded fetch for every TypeBuild network call.
//
// WHY THIS EXISTS (task fix/launch-latency-debug, 2026-07-05):
// A bare `fetch()` against a socket that CONNECTS but never responds waits on
// undici's default headers timeout (~300s / 5min) before rejecting. The task
// launch path fans out ~5 fetches in a single Promise.all (mint,
// operator-instructions, context-bundle, project, getTask) plus N data-ref
// resolves — and EVERY one of them first awaits getIdToken()'s token refresh,
// which is itself a bare fetch to Firebase. Any ONE of those legs hitting a
// blackholed/half-open socket stalls the WHOLE wave (Promise.all waits for the
// slowest leg), so the operator window sits with no action for minutes. A user
// hit exactly this: window popped instantly, then >2min of nothing.
//
// The endpoints are normally fast (<200ms), so this is a fail-FAST guard for the
// pathological dead-socket case, not a normal-path throttle. On timeout we abort
// the request and throw a tagged error; callers' existing try/catch degrade it
// (best-effort legs → empty; the mint → a typed 'unreachable' the renderer shows
// immediately) instead of hanging.
//
// PHI/security: no request/response bodies are logged here — this only wraps the
// transport with an AbortController.

/** Default per-request budget for TypeBuild API calls. Endpoints normally answer
 *  in well under 200ms; 8s is a generous ceiling that still fails fast enough to
 *  keep task-start responsive when a socket is dead. */
export const DEFAULT_FETCH_TIMEOUT_MS = 8000;

/** Thrown (name 'FetchTimeoutError') when a request exceeds its budget. Existing
 *  catch blocks treat it like any transport failure. */
export class FetchTimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms}ms`);
    this.name = 'FetchTimeoutError';
  }
}

// ─── shared origin gate: concurrency cap + circuit breaker ──────────────────
// (task-24cd55d8a607 — slow-episode resilience)
//
// EVERY TypeBuild-origin request in MAIN funnels through fetchWithTimeout: the
// list poll + getTask + project resolve (TypeBuildTaskSource.request), the MCP
// token mint, and the N-per-item enrichment waves (per-task audit fetches,
// per-key data-bag value resolves) that the New Home roster + template matrix
// issue on every 30s poll. Before this gate those waves fanned out from several
// INDEPENDENT per-hook concurrency caps (audit=4 ∪ chained=4 ∪ children=4 ∪
// fast-poll=4 ∪ dataValues=4), so a slow server saw dozens of sockets in flight
// at once. They piled up, EACH hit the 8s budget, and even the mint for a Run
// timed out behind the backlog — the UI then collapsed to the stripped-down
// "All projects / nameless default group" view.
//
// Two guards, both here at the single choke point:
//   1. A shared SEMAPHORE caps total in-flight origin requests to
//      MAX_ORIGIN_CONCURRENCY. A slow server now degrades to SLOWER loads (a
//      queue drains at a bounded rate) instead of an unbounded pile-up.
//   2. A CIRCUIT BREAKER counts consecutive timeouts. After
//      TIMEOUT_TRIP_THRESHOLD in a row it opens (marks the origin "degraded");
//      the first success closes it. The renderer subscribes to this state and
//      DEFERS the non-essential enrichment waves while degraded, keeping only
//      the core list poll (+ user actions) running until the origin recovers.
//
// PHI/security: only request COUNTS and the boolean degraded flag are tracked
// here — never URLs, bodies, or headers.

/** Max simultaneous in-flight requests to the TypeBuild origin. Small on
 *  purpose: the endpoints are normally <200ms, so a handful of slots drains a
 *  wave quickly on a healthy server and bounds the backlog on a slow one. */
export const MAX_ORIGIN_CONCURRENCY = 5;

/** Consecutive timeouts that trip the breaker open ("origin degraded"). One
 *  slow response is noise; three in a row is an episode. */
export const TIMEOUT_TRIP_THRESHOLD = 3;

let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_ORIGIN_CONCURRENCY) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight += 1;
}

function releaseSlot(): void {
  inFlight -= 1;
  const next = waiters.shift();
  if (next) next();
}

let consecutiveTimeouts = 0;
let degraded = false;
const degradedListeners = new Set<(degraded: boolean) => void>();

function setDegraded(next: boolean): void {
  if (next === degraded) return;
  degraded = next;
  for (const fn of degradedListeners) {
    try {
      fn(degraded);
    } catch {
      /* a listener must never break the transport */
    }
  }
}

/** True while the breaker is open — N consecutive origin timeouts with no
 *  success since. The renderer reads this to defer enrichment waves. */
export function isOriginDegraded(): boolean {
  return degraded;
}

/** Subscribe to breaker open/close transitions. Returns an unsubscribe fn.
 *  Used by the IPC layer to broadcast the degraded flag to every renderer. */
export function onOriginHealthChange(fn: (degraded: boolean) => void): () => void {
  degradedListeners.add(fn);
  return () => degradedListeners.delete(fn);
}

function recordTimeout(): void {
  consecutiveTimeouts += 1;
  if (consecutiveTimeouts >= TIMEOUT_TRIP_THRESHOLD) setDegraded(true);
}

function recordSuccess(): void {
  consecutiveTimeouts = 0;
  setDegraded(false);
}

/**
 * fetch() with a hard timeout, gated by the shared origin concurrency cap and
 * feeding the circuit breaker. Aborts the underlying request when `timeoutMs`
 * elapses and rejects with {@link FetchTimeoutError}. If the caller passes its
 * own `signal`, we chain it so an external abort still works.
 *
 * The request waits for a concurrency SLOT before it starts (bounding the
 * origin backlog during a slow episode), and its timeout/success updates the
 * breaker so the renderer can defer enrichment waves while the origin is slow.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // Bound total in-flight requests to the origin. On a slow server the extra
  // callers queue here instead of opening dozens of parallel sockets that all
  // race the 8s budget and pile up.
  await acquireSlot();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new FetchTimeoutError(timeoutMs)), timeoutMs);
  // Bridge a caller-supplied signal into ours so both can abort the request.
  const external = init?.signal;
  if (external) {
    if (external.aborted) ac.abort(external.reason);
    else external.addEventListener('abort', () => ac.abort(external.reason), { once: true });
  }
  try {
    const res = await fetch(input, { ...init, signal: ac.signal });
    // A completed response (even a 5xx) means the origin is answering — clear
    // the breaker. It's specifically the dead/slow-socket TIMEOUT we count.
    recordSuccess();
    return res;
  } catch (err) {
    // Normalize the abort into our typed error so callers get a clear reason
    // rather than a bare DOMException('The operation was aborted').
    if (ac.signal.aborted && ac.signal.reason instanceof FetchTimeoutError) {
      recordTimeout();
      throw ac.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    releaseSlot();
  }
}
