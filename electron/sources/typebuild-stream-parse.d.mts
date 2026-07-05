// task-996487c8c388 — type surface for the pure SSE parsing core (plain ESM so
// `node --test` imports it without a transpile step).

/** True iff an SSE line is a "something changed" poke worth resyncing on. */
export function isChangedPoke(line: string): boolean;

/** Split accumulated SSE text into `\n`-delimited lines (CRLF-tolerant),
 *  invoking onLine per complete line; returns the leftover partial tail. */
export function splitLines(buffer: string, onLine: (line: string) => void): string;

/** Reconnect backoff: exponential from minMs, capped at maxMs, jittered to
 *  50–100% of base (jitterFrac in [0,1]). */
export function backoffDelay(
  attempt: number,
  jitterFrac: number,
  minMs?: number,
  maxMs?: number,
): number;
