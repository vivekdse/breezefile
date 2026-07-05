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

/**
 * fetch() with a hard timeout. Aborts the underlying request when `timeoutMs`
 * elapses and rejects with {@link FetchTimeoutError}. If the caller passes its
 * own `signal`, we chain it so an external abort still works.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new FetchTimeoutError(timeoutMs)), timeoutMs);
  // Bridge a caller-supplied signal into ours so both can abort the request.
  const external = init?.signal;
  if (external) {
    if (external.aborted) ac.abort(external.reason);
    else external.addEventListener('abort', () => ac.abort(external.reason), { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } catch (err) {
    // Normalize the abort into our typed error so callers get a clear reason
    // rather than a bare DOMException('The operation was aborted').
    if (ac.signal.aborted && ac.signal.reason instanceof FetchTimeoutError) {
      throw ac.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
