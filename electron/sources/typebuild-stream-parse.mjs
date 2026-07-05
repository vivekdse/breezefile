// task-996487c8c388 — the PURE, Electron-free SSE parsing core shared by the
// stream client (typebuild-stream.ts) and its tests, so the tested contract can
// never drift from the runtime (same pattern as db-key-derive.mjs). Owns the
// two decisions with edge cases: "is this line a change poke?" and the
// backoff-delay schedule.

/**
 * True iff an SSE line is a "something changed" poke we should resync on.
 * A poke is a `data:` line with a non-empty payload that is EITHER non-JSON
 * (tolerated — never drop a real signal) OR JSON whose `type` is "changed" (or
 * absent). Comment/keep-alive lines (":"...), blank lines, and other field
 * lines (event:/id:/retry:) are ignored. Never throws.
 */
export function isChangedPoke(line) {
  if (line === '' || line.startsWith(':')) return false;
  if (!line.startsWith('data:')) return false;
  const data = line.slice(5).trim();
  if (!data) return false;
  try {
    const parsed = JSON.parse(data);
    if (parsed && parsed.type && parsed.type !== 'changed') return false;
  } catch {
    // Not JSON — still a poke (the payload carries no PHI/routing we parse).
  }
  return true;
}

/**
 * Split accumulated SSE text into complete `\n`-delimited lines, invoking
 * onLine for each and returning the leftover partial tail. Strips a trailing
 * `\r` (CRLF). The caller keeps the returned tail and prepends the next chunk,
 * so an event split across chunks reassembles correctly.
 */
export function splitLines(buffer, onLine) {
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '');
    buffer = buffer.slice(nl + 1);
    onLine(line);
  }
  return buffer;
}

/** Reconnect backoff: exponential from BACKOFF_MIN_MS, capped at BACKOFF_MAX_MS,
 *  jittered to 50–100% of the base (jitterFrac in [0,1]). */
export function backoffDelay(attempt, jitterFrac, minMs = 1000, maxMs = 30000) {
  const base = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(base * (0.5 + jitterFrac * 0.5));
}
