// Human-in-the-loop observation — Brain C4 (task-17434e2b5469 "Brain C4 —
// Client learning from humans", child of the Brain epic task-8913f9bc2230).
// Depends on C1 (electron/typebuild/brain-writes.ts + site-memory.ts's
// captureObservation/captureTool — read those first, this module builds on
// them and does not duplicate their write/PHI-guard plumbing).
//
// WHAT THIS IS: when a PERSON is at the browser (co-driving the recorder, or
// correcting an agent run mid-task), this module watches the action stream +
// the page's navigation events for two shapes of signal worth remembering:
//
//   EXPLICIT CORRECTION — the human re-did a step the agent (or the human's
//     own prior action) already took: same field/selector acted on again
//     within a short window, or a DIFFERENT selector used for what looks like
//     the same logical step (a chosen path change).
//   IMPLICIT FEEDBACK — hesitation (a long dwell before acting), undo
//     (browser back / History back within the recorder's own patched
//     history), or re-navigation (revisiting a URL already seen this
//     session).
//
// Useful bits are promoted to the brain via site-memory.ts's captureObservation
// (a human correction is NOT a reusable code path by itself — see C1's own
// doc comment distinguishing captureObservation from captureTool — so this
// module always calls captureObservation, tagged so the curator can weight it).
//
// TAGGING CONVENTION (there is no dedicated schema field for this — checked
// brain_api/api.py's ObservationIn + schema.sql: memory_nodes has no
// "source"/"evidence_weight" column, and curator.py's _llm_contradict() only
// ever reads `evidence.tenant_count` / `evidence.run_ids` out of the freeform
// `evidence` JSONB today; `provenance` is a server/curator-owned TEXT
// narrative the client cannot set). So we do the only thing the current wire
// contract supports, and do it twice for redundancy:
//   1. evidence.source = 'human_correction' | 'human_implicit' — a plain
//      string tag riding in the existing freeform `evidence` dict (additive;
//      ignored harmlessly by any code that doesn't look for it yet, same as
//      any other new evidence key would be).
//   2. The observation `body` text ITSELF states the provenance in its first
//      word ("Human correction:" / "Human hesitation:" / "Human re-navigated:"
//      / "Human undo:") because curator.py's contradiction arbiter is an LLM
//      reading `body` narratively (prompts/contradict.md), so a human-sourced
//      correction reads as higher-weight evidence to the arbiter even before
//      any server-side change teaches it to look at evidence.source
//      specifically. Recording BOTH means this works today (via the LLM
//      narrative reading) and is ready to be picked up by a future
//      curator.py change that starts keying off evidence.source directly —
//      follow-up filed against task_manager_api (see bottom of this file).
//
// NON-PHI DISCIPLINE (hard boundary, mirrored EXACTLY from
// site-memory.ts's addSiteMemory/addTaskMemory + record-preload.mjs's
// placeholderKeyFor): we capture the MECHANISM, never the VALUE.
//   - A corrected FIELD is reported as its placeholder KEY (name/id/aria-label/
//     associated <label> text/placeholder attr — see record-preload.mjs
//     placeholderKeyFor), never the characters the human typed.
//   - A corrected STEP is reported as the selector KIND + selector STRING
//     (e.g. "css=#submit-btn"), never any DOM text content beyond what a
//     selector already structurally is (a `text=` selector is itself capped
//     at 80 chars of visible label text in record-preload.mjs, matching the
//     recorder's own existing precedent — this module doesn't relax that).
//   - A re-navigation/undo is reported as a URL (already page-shape metadata,
//     the same class of data net.mjs's requestMeta reports for every request)
//     plus a timing delta in milliseconds. Never form data, never query
//     params beyond the URL Playwright/the DOM already exposes to every
//     script on the page.
//   - Hesitation is reported as a DURATION in milliseconds only.
// This module adds NO client-side text scanner beyond that — like C1, the
// server remains the PHI enforcement backstop (422) for anything that slips
// through; we just never construct a body that could contain a value.
//
// LISTENER PRECEDENT: net.mjs's observeNetwork (page.on('request', ...) /
// page.off(...) around a bounded window) is the existing transient-listener
// shape in this codebase. attachHumanObserver here follows the same shape for
// Playwright's page: install listeners, return a detach function, never leave
// a dangling listener if the caller forgets to call it (best-effort try/catch
// around every handler, exactly like onRequest in net.mjs).

import { captureObservation } from '../typebuild/site-memory';

export type HumanActionKind = 'click' | 'input' | 'change' | 'navigate';

/** One action in the observed stream — the shape the teach-by-recording
 *  preload already emits (record.ts's RawAction) or an equivalent produced by
 *  a live Playwright listener. Kept structurally compatible with
 *  record.ts's RawAction/RecordedAction so a caller can feed either straight
 *  in without translation. */
export interface HumanAction {
  action: HumanActionKind;
  url: string;
  timestamp: number;
  /** Selector KIND + STRING only — see NON-PHI discipline above. */
  selector?: { kind: string; selector: string } | null;
  /** Placeholder KEY only (field identity) — never the typed value. */
  placeholder?: string;
  inputType?: string;
  /** navigate only: destination URL. */
  to?: string;
}

export type CorrectionKind = 'correction' | 'hesitation' | 'renavigation' | 'undo';

/** One inferred human-feedback signal, ready to become a brain observation. */
export interface HumanSignal {
  kind: CorrectionKind;
  /** NON-PHI mechanism summary — see buildObservationBody. */
  detail: {
    placeholder?: string;
    selectorKind?: string;
    selectorPrevKind?: string;
    url?: string;
    deltaMs: number;
  };
}

const CORRECTION_WINDOW_MS = 15_000; // re-touch of the same field/step within 15s
const HESITATION_THRESHOLD_MS = 8_000; // dwell before acting judged as hesitation
const RENAV_WINDOW_MS = 5 * 60_000; // revisit of a URL already seen this session

/** Identity of "the same logical step" for correction detection: the
 *  placeholder key when present (a form field), else the selector string.
 *  Never the value. */
function stepIdentity(a: HumanAction): string | null {
  if (a.placeholder) return `field:${a.placeholder}`;
  if (a.selector?.selector) return `sel:${a.selector.kind}:${a.selector.selector}`;
  return null;
}

/**
 * Scan a chronological action stream and infer human correction / hesitation /
 * re-navigation / undo signals. PURE function — no I/O, no brain writes; the
 * caller (attachHumanObserver, or a session's stop path) decides what to do
 * with the signals (typically: promoteHumanSignal for each).
 *
 * Detection rules (deliberately simple/precedent-following, not ML):
 *   - CORRECTION: the same step identity (field or selector) is acted on
 *     again within CORRECTION_WINDOW_MS — the human redid a step. If the
 *     later action targets a DIFFERENT selector for what looks like the same
 *     placeholder, we still call it a correction (selectorPrevKind differs) —
 *     that's a "chose a different path" correction, exactly the shape the
 *     task calls out.
 *   - HESITATION: the gap between one action and the next exceeds
 *     HESITATION_THRESHOLD_MS with no navigation in between — the human
 *     paused before acting.
 *   - UNDO: a `navigate` action whose `to` equals a URL seen EARLIER in the
 *     stream, arriving via a short back-hop (we can't see the history API's
 *     direction, so we treat "revisits the immediately-previous distinct URL"
 *     as undo; anything older is treated as a plain re-navigation).
 *   - RENAVIGATION: a `navigate` action whose `to` was already visited more
 *     than one hop back, within RENAV_WINDOW_MS — the human went back to a
 *     page they'd already left.
 */
export function detectHumanSignals(actions: HumanAction[]): HumanSignal[] {
  const signals: HumanSignal[] = [];
  const lastSeenAt = new Map<string, HumanAction>(); // stepIdentity -> last action
  const urlHistory: { url: string; at: number }[] = [];
  let prevAction: HumanAction | null = null;

  for (const a of actions) {
    // Hesitation: gap since the previous action, regardless of kind.
    if (prevAction && a.timestamp > prevAction.timestamp) {
      const deltaMs = a.timestamp - prevAction.timestamp;
      if (deltaMs >= HESITATION_THRESHOLD_MS) {
        signals.push({ kind: 'hesitation', detail: { deltaMs } });
      }
    }

    if (a.action === 'navigate') {
      const dest = a.to || a.url;
      if (dest) {
        const prevDistinctUrl = urlHistory.length ? urlHistory[urlHistory.length - 1].url : null;
        const priorVisit = urlHistory.find((h) => h.url === dest);
        if (priorVisit) {
          const deltaMs = a.timestamp - priorVisit.at;
          if (prevDistinctUrl && urlHistory.length >= 2 && urlHistory[urlHistory.length - 2].url === dest) {
            // Revisits the URL immediately before the last one — a back-hop.
            signals.push({ kind: 'undo', detail: { url: dest, deltaMs } });
          } else if (deltaMs <= RENAV_WINDOW_MS) {
            // Older revisit, but still within the session-scale window — a
            // deliberate re-navigation back to earlier context. A revisit far
            // outside this window (a genuinely new session touching the same
            // URL again much later) is not treated as a feedback signal.
            signals.push({ kind: 'renavigation', detail: { url: dest, deltaMs } });
          }
        }
        urlHistory.push({ url: dest, at: a.timestamp });
      }
    } else {
      const id = stepIdentity(a);
      if (id) {
        const prior = lastSeenAt.get(id);
        if (prior && a.timestamp - prior.timestamp <= CORRECTION_WINDOW_MS) {
          signals.push({
            kind: 'correction',
            detail: {
              placeholder: a.placeholder,
              selectorKind: a.selector?.kind,
              selectorPrevKind: prior.selector?.kind,
              deltaMs: a.timestamp - prior.timestamp,
            },
          });
        }
        lastSeenAt.set(id, a);
      }
    }

    prevAction = a;
  }

  return signals;
}

/** Render a NON-PHI observation body for a signal. First word states the
 *  provenance (see the module doc comment on why the body text itself
 *  restates what evidence.source says) so a narrative-reading curator LLM
 *  weights it correctly even before it's taught to key off evidence.source. */
export function buildObservationBody(signal: HumanSignal): string {
  const { detail } = signal;
  switch (signal.kind) {
    case 'correction': {
      const where = detail.placeholder ? `field="${detail.placeholder}"` : 'a step';
      const pathNote =
        detail.selectorPrevKind && detail.selectorKind && detail.selectorPrevKind !== detail.selectorKind
          ? ` (switched from a ${detail.selectorPrevKind} selector to a ${detail.selectorKind} selector)`
          : '';
      return `Human correction: redid ${where}${pathNote} ${Math.round(detail.deltaMs)}ms after the first attempt.`;
    }
    case 'hesitation':
      return `Human hesitation: paused ${Math.round(detail.deltaMs)}ms before the next action.`;
    case 'undo':
      return `Human undo: navigated back to a previously-visited page after ${Math.round(detail.deltaMs)}ms.`;
    case 'renavigation':
      return `Human re-navigated: revisited an earlier page in this session after ${Math.round(detail.deltaMs)}ms.`;
    default:
      return 'Human feedback signal.';
  }
}

/** Which capture 'kind' + evidence tag a signal maps to. Corrections are the
 *  strongest signal (an explicit redo), so they get the 'human_correction'
 *  evidence.source tag; hesitation/undo/renavigation are implicit and get
 *  'human_implicit' — still promoted, but the curator can (once it reads the
 *  tag) weight them below an explicit correction. */
function evidenceSourceFor(kind: CorrectionKind): 'human_correction' | 'human_implicit' {
  return kind === 'correction' ? 'human_correction' : 'human_implicit';
}

/** Promote one detected signal to the brain via site-memory.ts's
 *  captureObservation (C1). Fire-and-forget, mirrors captureObservation's own
 *  contract exactly (never throws, never blocks the caller) — this function
 *  itself does not even return a promise the caller must await. `domain`
 *  should be the page's registrable domain when known (site-scoped, 'org'
 *  tier — a correction pattern is worth remembering across future runs on
 *  that site); omit it and the observation is scoped 'task' via
 *  captureObservation's own taskId-present default. */
export function promoteHumanSignal(
  signal: HumanSignal,
  opts: {
    domain?: string;
    urlPattern?: string;
    taskId?: string;
    projectId?: string;
    tenantId?: string;
  } = {},
  capture: (
    kind: 'memory' | 'tool',
    body: string,
    captureOpts: Record<string, unknown>,
  ) => void = defaultCapture,
): void {
  const body = buildObservationBody(signal);
  capture('memory', body, {
    tier: opts.domain ? 'org' : opts.taskId ? 'task' : 'org',
    domain: opts.domain,
    urlPattern: signal.detail.url || opts.urlPattern,
    taskId: opts.taskId,
    projectId: opts.projectId,
    tenantId: opts.tenantId,
    summary: `${signal.kind} (human-observed)`,
    evidence: {
      source: evidenceSourceFor(signal.kind),
      signal_kind: signal.kind,
      delta_ms: Math.round(signal.detail.deltaMs),
    },
  });
}

// Bound to site-memory.ts's captureObservation (C1). Kept as an indirection
// (rather than every caller importing captureObservation directly) so the
// pure detectHumanSignals/buildObservationBody functions above stay trivially
// unit-testable — tests pass their own `capture` stub to
// promoteHumanSignal/observeAndPromote instead of exercising the real network
// path, same "faithful re-implementation over a stub" discipline as
// tests/brain-writes.test.mjs.
function defaultCapture(kind: 'memory' | 'tool', body: string, captureOpts: Record<string, unknown>): void {
  void captureObservation(kind, body, captureOpts as Parameters<typeof captureObservation>[2]);
}

/** Scan the full stream once and promote every detected signal. Convenience
 *  wrapper over detectHumanSignals + promoteHumanSignal for callers (e.g.
 *  record.ts's stopRecording, or a live session's periodic flush) that just
 *  want "observe this stream, capture whatever's useful." Never throws. */
export function observeAndPromote(
  actions: HumanAction[],
  opts: { domain?: string; taskId?: string; projectId?: string; tenantId?: string } = {},
): HumanSignal[] {
  const signals = detectHumanSignals(actions);
  for (const s of signals) {
    try {
      promoteHumanSignal(s, opts);
    } catch {
      /* promotion is best-effort; one bad signal must never drop the rest */
    }
  }
  return signals;
}

// ─── live Playwright listener (no navigation/undo listener existed before
// this task) ────────────────────────────────────────────────────────────────
//
// Minimal Playwright surface used here (kept structural so this file stays
// importable/typecheckable without a hard `playwright` type dependency,
// mirroring net.mjs's duck-typed `page` param).
export interface ObservablePage {
  on(event: 'framenavigated', handler: (frame: { url(): string; parentFrame(): unknown }) => void): unknown;
  off(event: 'framenavigated', handler: (frame: { url(): string; parentFrame(): unknown }) => void): unknown;
  url(): string;
}

/**
 * Attach a TRANSIENT 'framenavigated' listener to a live Playwright page and
 * feed each top-frame navigation into the same detectHumanSignals pipeline
 * used for the recorder's action stream — the piece that didn't exist before
 * this task (net.mjs's page.on('request', ...) is the sibling precedent this
 * mirrors for the navigation case). Returns a detach function; the caller MUST
 * call it when done observing (e.g. when the run ends or hands control back),
 * exactly like net.mjs's observeNetwork detaches its own 'request' listener in
 * a `finally`.
 *
 * This function is additive to, not a replacement for, the recorder's own
 * preload-based click/input/change capture (record-preload.mjs already covers
 * those for a CO-DRIVING session); it exists for the case where the agent
 * itself is driving via Playwright and the human corrects it by navigating
 * the SAME page out from under the agent (no preload toggle involved).
 */
export function attachHumanObserver(
  page: ObservablePage,
  opts: { domain?: string; taskId?: string; projectId?: string; tenantId?: string } = {},
): { detach: () => void; getActions: () => HumanAction[] } {
  const actions: HumanAction[] = [];

  const onFrameNavigated = (frame: { url(): string; parentFrame(): unknown }) => {
    try {
      if (frame.parentFrame()) return; // only the top-level frame counts as a navigation
      const url = frame.url();
      if (!url) return;
      actions.push({ action: 'navigate', url, to: url, timestamp: Date.now() });
      // Flush signals incrementally so a long-running session doesn't need to
      // wait for detach() to promote what's already known — mirrors
      // captureObservation's own "never block, never accumulate risk" spirit.
      const signals = detectHumanSignals(actions);
      const latest = signals[signals.length - 1];
      if (latest && (latest.kind === 'undo' || latest.kind === 'renavigation')) {
        promoteHumanSignal(latest, opts);
      }
    } catch {
      /* a frame can vanish mid-navigation; never let this break the run */
    }
  };

  page.on('framenavigated', onFrameNavigated);

  return {
    detach: () => {
      try {
        page.off('framenavigated', onFrameNavigated);
      } catch {
        /* ignore */
      }
    },
    getActions: () => actions.slice(),
  };
}

// ─── follow-up filed ────────────────────────────────────────────────────────
// Server-side follow-up (task_manager_api / brain_api, project-df6cef3fbc84):
// teach curator.py's _llm_contradict() (+ prompts/contradict.md) to read
// evidence.source ('human_correction' | 'human_implicit' | absent) as an
// explicit tie-breaker ahead of tenant_count/run_count, per this task's
// requirement that human corrections be weighted higher in contradiction
// resolution. Filed as a create_task against project-df6cef3fbc84,
// cross-referencing task-17434e2b5469.
