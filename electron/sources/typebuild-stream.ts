// task-996487c8c388 — main-process SSE client for the taskapi "something
// changed" push (GET /chromeext/stream), the live TRIGGER half of the local-DB
// sync epic (task-b3fb2928bb3c). The stream tells the client TO look; the
// existing delta reconcile loop (poll() → ?updated_since= → applyDelta) is HOW
// it looks. So this module owns ONLY the connection lifecycle and turns each
// signal into an onSignal() callback — it never parses task data (there is none
// on the stream) and never touches the cache/DB itself.
//
// Design (per the server contract):
//   - Endpoint GET /chromeext/stream, Firebase Bearer, text/event-stream.
//   - Events: `data: {"type":"changed","at":"<iso>"}` + `: keep-alive` comments.
//     PHI-FREE by construction — no id/title/status ever on the wire.
//   - The signal is a pure poke; a missed one is harmless because the client
//     ALWAYS resyncs on connect/reconnect too. So: fire onSignal() on connect
//     AND on every `changed` event; reconnect with backoff on any drop.
//   - Held in the MAIN process (survives renderer reload / window close), via a
//     streaming fetch + AbortController rather than a renderer EventSource
//     (EventSource can't set the Authorization header).
//
// This module is transport-only and has no Electron dependency beyond the
// injected token/base — the source wires it to getIdToken + API_BASE.

// The SSE line/backoff semantics live in the shared pure module
// typebuild-stream-parse.mjs so the tests exercise the SAME code the runtime
// does (no drift).
import { isChangedPoke, splitLines, backoffDelay } from './typebuild-stream-parse.mjs';

// Coalesce a burst of `changed` events (e.g. a bulk write fanning out several
// signals) into ONE resync within this window. Keeps the reconcile loop from
// running N times for N near-simultaneous pokes.
const SIGNAL_DEBOUNCE_MS = 300;
// A connection must stay up at least this long before we treat it as "healthy"
// and reset the reconnect backoff — guards against an accept-then-immediately-
// drop endpoint turning into a tight reconnect loop.
const STABLE_CONNECTION_MS = 10_000;

export interface TaskStreamOptions {
  /** Base URL, e.g. https://general.typebuild.com (no trailing slash). */
  apiBase: string;
  /** Resolve a fresh Firebase ID token (auto-refreshing) per (re)connect. */
  getToken: () => Promise<string>;
  /** Called on connect, on reconnect, and on each debounced `changed` signal —
   *  the source wires this to its delta reconcile (poll()). Must not throw. */
  onSignal: () => void;
  /** Deterministic jitter source (0..1). Injectable for tests; defaults to a
   *  fixed 0.5 (no randomness) since Math.random is unavailable in some runtimes
   *  here — a tiny per-attempt variation is derived from the attempt count. */
  jitter?: (attempt: number) => number;
}

export class TaskStreamClient {
  private abort: AbortController | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: TaskStreamOptions) {}

  /** Open the stream and keep it open (reconnecting on drop) until stop(). Safe
   *  to call once per sign-in; a second call while running is a no-op. */
  start(): void {
    if (this.abort || this.reconnectTimer) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  /** Tear down the stream and cancel any pending reconnect/debounce. Call on
   *  sign-out. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        /* ignore */
      }
      this.abort = null;
    }
  }

  // ─── connection ───────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.abort = abort;

    let token: string;
    try {
      token = await this.opts.getToken();
    } catch {
      // Signed out / token unavailable — back off and retry (sign-out will
      // stop() us anyway). Don't fire onSignal (nothing to sync to).
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    let res: Response;
    try {
      res = await fetch(`${this.opts.apiBase}/chromeext/stream`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        signal: abort.signal,
      });
    } catch {
      // Network error establishing the stream — reconnect with backoff.
      if (!this.stopped) this.scheduleReconnect();
      return;
    }

    if (!res.ok || !res.body) {
      // 401/5xx/empty — back off. A 401 here means the token was revoked; the
      // next getToken() will refresh or the sign-out path will stop() us.
      if (!this.stopped) this.scheduleReconnect();
      return;
    }

    // Connected — RESYNC ON CONNECT (rule 1: never trust the stream alone; catch
    // up on anything missed while disconnected).
    this.fireSignal();

    // Reset the backoff only once the connection has been STABLY up (not merely
    // on headers received). A server/proxy that accepts then immediately drops
    // the stream every time would otherwise reset attempt=0 each cycle → a tight
    // reconnect storm. Arm a timer that clears on drop, so backoff keeps growing
    // for a flapping endpoint but resets for a genuinely healthy long-lived one.
    const stableTimer = setTimeout(() => {
      this.attempt = 0;
    }, STABLE_CONNECTION_MS);

    try {
      await this.readLoop(res.body);
    } catch {
      // Stream error mid-read — fall through to reconnect.
    } finally {
      clearTimeout(stableTimer);
    }
    // The stream ended (server closed, network dropped, or we aborted). If we
    // didn't stop() deliberately, reconnect with backoff.
    if (!this.stopped) this.scheduleReconnect();
  }

  // Read the SSE byte stream, split into lines, and fire a (debounced) signal on
  // each `changed` data event. Keep-alive comment lines (`:`...) and any other
  // event types are ignored. We don't need to parse the JSON payload — its only
  // field is a timestamp; the mere arrival of a `changed` event is the trigger.
  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited; process complete lines via the shared
      // parser, keeping the partial tail for the next chunk.
      buf = splitLines(buf, (line) => {
        if (isChangedPoke(line)) this.fireSignal();
      });
    }
  }

  // Debounce so a burst of signals coalesces into one reconcile.
  private fireSignal(): void {
    if (this.stopped) return;
    if (this.debounceTimer) return; // a resync is already scheduled within window
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped) return;
      try {
        this.opts.onSignal();
      } catch {
        // onSignal (poll) must never break the stream loop.
      }
    }, SIGNAL_DEBOUNCE_MS);
  }

  private scheduleReconnect(): void {
    this.abort = null;
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.attempt++;
    // Exponential backoff, capped, with jitter (shared pure impl).
    const jitterFrac = this.opts.jitter ? this.opts.jitter(attempt) : 0.5;
    const delay = backoffDelay(attempt, jitterFrac);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
