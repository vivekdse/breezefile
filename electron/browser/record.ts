// Teach-by-recording — MAIN-process recorder.
//
// Drives one recording session over a single embedded browser view's
// webContents. The PAGE preload (record-preload.mjs) captures the human's
// actions and the DOM-readable selector candidates; THIS module:
//   1. toggles the page preload on/off ('tb-record:set'),
//   2. enriches each action with a `matchCount` per candidate (uniqueness, via
//      executeJavaScript querySelectorAll length) and a role+accessible-name
//      candidate (the one thing JS can't compute faithfully) read from the
//      ACCESSIBILITY TREE over the built-in webContents.debugger,
//   3. ranks the candidates (selector-candidates.mjs) so each action carries the
//      most-stable pick, and
//   4. on stop, persists the recorded skill into the shared NON-PHI memory store
//      ONLINE (task-8593b18bd7da): a recorded flow is shared site memory, so it
//      WRITE-THROUGHs to /chromeext/site-memory (kind='flow') via the typed
//      addSiteMemory helper — same store every machine + teammate recalls. The
//      local JSON write stays as an OFFLINE cache so a recording made while the
//      server is unreachable (or rejected) is never lost on the machine.
//
// SINGLE-CLIENT CDP: webContents.debugger.attach collides with Playwright's
// connectOverCDP. During RECORD mode the human drives, so the agent's Playwright
// session must be released first (see connect.mjs releaseForRecording). This
// module only owns the debugger half; it attaches on start and detaches on stop.
//
// PHI INVARIANT: we persist SELECTORS and structure only. Typed values never
// reach here — the preload sends a placeholder KEY, never the value.

import type { WebContents } from 'electron';
import { rankCandidates, bestCandidate } from './selector-candidates.mjs';
import { addMemory } from './tools/memory.mjs';
// MAIN-process write-through to the SHARED online site-memory store. record.ts
// runs in MAIN (it holds the real Firebase token via typebuildFetch), so it
// reaches the server directly — no localhost /app/site-memory proxy hop needed.
import { addSiteMemory, captureTool } from '../typebuild/site-memory';

export type RawCandidate = { kind: string; selector: string };
export type ScoredCandidate = RawCandidate & { matchCount?: number; score?: number };

export type RawAction = {
  action: 'click' | 'input' | 'change' | 'navigate';
  url: string;
  timestamp: number;
  candidates: RawCandidate[];
  placeholder?: string;
  inputType?: string;
  to?: string;
};

export type RecordedAction = {
  action: string;
  url: string;
  candidates: ScoredCandidate[];
  best: ScoredCandidate | null;
  placeholder?: string;
  inputType?: string;
};

type Session = {
  wc: WebContents;
  webContentsId: number;
  actions: RecordedAction[];
  debuggerAttached: boolean;
  onMessage: (e: unknown, channel: string, ...args: unknown[]) => void;
};

let active: Session | null = null;

/** Is a recording session currently live? */
export function isRecording(): boolean {
  return active != null;
}

/** Attach the AX debugger best-effort. The page is single-client over CDP, so
 *  the agent's Playwright session must already be released. Never throws. */
function attachDebugger(wc: WebContents): boolean {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch {
    // Already attached by something else (e.g. Playwright still connected) —
    // we degrade gracefully: candidates just won't get a role+name entry.
    return wc.debugger.isAttached();
  }
  try {
    void wc.debugger.sendCommand('Accessibility.enable');
  } catch {
    /* AX domain unavailable — degrade */
  }
  return true;
}

function detachDebugger(wc: WebContents): void {
  try {
    if (wc.debugger.isAttached()) {
      try {
        void wc.debugger.sendCommand('Accessibility.disable');
      } catch {
        /* ignore */
      }
      wc.debugger.detach();
    }
  } catch {
    /* ignore */
  }
}

/** Count how many elements a candidate selector matches RIGHT NOW (1 == unique,
 *  0 == not found/stale). Text/role engine selectors aren't plain CSS, so we
 *  evaluate them structurally; CSS-shaped ones go through querySelectorAll. */
async function matchCountFor(wc: WebContents, c: RawCandidate): Promise<number> {
  // text= and role= are Playwright engine prefixes, not CSS — approximate.
  if (c.kind === 'text') {
    const needle = c.selector.replace(/^text=/, '');
    const expr = `(() => { let n=0; const t=${JSON.stringify(needle)};
      document.querySelectorAll('*').forEach(el => {
        if ((el.textContent||'').replace(/\\s+/g,' ').trim() === t && el.children.length===0) n++;
      }); return n; })()`;
    return evalCount(wc, expr);
  }
  // CSS-shaped (testid/id/arialabel/css/nth). role candidates are injected by
  // MAIN already carrying their own matchCount, so they don't reach here.
  const expr = `(() => { try { return document.querySelectorAll(${JSON.stringify(c.selector)}).length; } catch { return -1; } })()`;
  const n = await evalCount(wc, expr);
  return n < 0 ? 0 : n;
}

async function evalCount(wc: WebContents, expr: string): Promise<number> {
  try {
    const r = await wc.executeJavaScript(expr, true);
    return typeof r === 'number' ? r : 0;
  } catch {
    return 0;
  }
}

/** Best-effort role + accessible name for the acted element, read from the
 *  ACCESSIBILITY TREE over the debugger — the one signal JS in the page can't
 *  compute faithfully (the ARIA accname spec). We resolve the element by a
 *  unique CSS-shaped candidate (DOM.querySelector → backendNodeId), then read
 *  its role + name via Accessibility.getPartialAXTree. Returns a Playwright
 *  role= candidate or null (we degrade silently — the DOM-read candidates still
 *  give Claude Code plenty to choose from). */
async function roleNameCandidate(
  session: Session,
  raw: RawAction,
): Promise<(RawCandidate & { matchCount: number }) | null> {
  if (!session.debuggerAttached) return null;
  // Pick a unique, CSS-resolvable candidate to anchor the lookup.
  const anchor = (raw.candidates || []).find(
    (c) => (c.kind === 'id' || c.kind === 'testid' || c.kind === 'css') && c.selector,
  );
  if (!anchor) return null;
  const wc = session.wc;
  try {
    const doc = (await wc.debugger.sendCommand('DOM.getDocument', { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootId = doc?.root?.nodeId;
    if (rootId == null) return null;
    const found = (await wc.debugger.sendCommand('DOM.querySelector', {
      nodeId: rootId,
      selector: anchor.selector,
    })) as { nodeId?: number };
    if (!found?.nodeId) return null;
    const ax = (await wc.debugger.sendCommand('Accessibility.getPartialAXTree', {
      nodeId: found.nodeId,
      fetchRelatives: false,
    })) as { nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> };
    const node = ax?.nodes?.[0];
    const role = node?.role?.value;
    const name = node?.name?.value;
    if (typeof role !== 'string' || !role) return null;
    const nm = typeof name === 'string' ? name : '';
    const selector = nm ? `role=${role}[name="${nm.replace(/"/g, '\\"')}"]` : `role=${role}`;
    // A role+name pair is the most stable signal we have; treat it as unique
    // (the accname is computed per the spec, and we anchored on a unique node).
    return { kind: 'role', selector, matchCount: 1 };
  } catch {
    return null;
  }
}

/** Enrich one raw action: add matchCount to every candidate, append a role+name
 *  candidate when available, rank, and pick the best. */
async function enrich(session: Session, raw: RawAction): Promise<RecordedAction> {
  const wc = session.wc;
  const withCounts: ScoredCandidate[] = [];
  for (const c of raw.candidates || []) {
    const matchCount = await matchCountFor(wc, c);
    withCounts.push({ ...c, matchCount });
  }
  const roleC = await roleNameCandidate(session, raw);
  if (roleC) withCounts.unshift(roleC);
  const ranked = rankCandidates(withCounts) as ScoredCandidate[];
  return {
    action: raw.action,
    url: raw.url,
    candidates: ranked,
    best: bestCandidate(withCounts) as ScoredCandidate | null,
    ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
    ...(raw.inputType ? { inputType: raw.inputType } : {}),
  };
}

/** Start recording on a webContents. Toggles the page preload on and attaches
 *  the AX debugger. Returns { ok } / { ok:false, error }. */
export function startRecording(wc: WebContents): { ok: boolean; error?: string } {
  if (active) return { ok: false, error: 'already recording' };
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no live web view' };

  const debuggerAttached = attachDebugger(wc);
  const session: Session = {
    wc,
    webContentsId: wc.id,
    actions: [],
    debuggerAttached,
    onMessage: () => {},
  };

  // The page preload exfiltrates via ipcRenderer.sendToHost → surfaces here as
  // the webContents' 'ipc-message' event.
  session.onMessage = (_e, channel, ...args) => {
    if (channel !== 'tb-record:action') return;
    const raw = args[0] as RawAction;
    if (!raw || typeof raw !== 'object') return;
    void enrich(session, raw).then((rec) => {
      session.actions.push(rec);
    });
  };
  wc.on('ipc-message', session.onMessage);

  active = session;
  try {
    wc.send('tb-record:set', true);
  } catch {
    /* page not ready yet — it'll get the toggle on its next load via re-send */
  }
  return { ok: true };
}

/** Stop recording. Detaches the debugger, WRITE-THROUGHs the recorded actions as
 *  a NON-PHI skill into the SHARED ONLINE site-memory store (kind='flow'), and
 *  returns the full recording so the caller can hand it to Claude Code. Async
 *  because the online write round-trips the server; on an offline/server error we
 *  fall back to the LOCAL cache so a recording is never lost (`online` reports
 *  which path persisted it). */
export async function stopRecording(opts: { skillName?: string } = {}): Promise<{
  ok: boolean;
  error?: string;
  actions?: RecordedAction[];
  site?: string;
  saved?: boolean;
  online?: boolean;
}> {
  const session = active;
  if (!session) return { ok: false, error: 'not recording' };
  active = null;

  const wc = session.wc;
  try {
    if (!wc.isDestroyed()) wc.send('tb-record:set', false);
  } catch {
    /* ignore */
  }
  try {
    wc.off('ipc-message', session.onMessage);
  } catch {
    /* ignore */
  }
  if (!wc.isDestroyed()) detachDebugger(wc);

  const actions = session.actions.slice();
  const site = deriveSite(actions);
  let saved = false;
  let online = false;
  if (site && actions.length) {
    // Persist HOW-TO, not values: one NON-PHI note per session describing the
    // stablest selector per step. The recorded flow fits the site-memory body/
    // kind contract as kind='flow' (a multi-step how-to). The text is built from
    // selectors + placeholder KEYS only (formatSkill); the server PHI-guards the
    // write as a second line of defense (422 on a value-shaped body).
    const text = formatSkill(opts.skillName, actions);
    try {
      // WRITE-THROUGH to the SHARED online store so the recorded skill is shared
      // like other site memory. addSiteMemory also refreshes the local cache.
      // skipBrain: true here — a recorded flow is a discovered REUSABLE PATH,
      // which fits the brain's propose_tool primitive better than a generic
      // memory observation (addSiteMemory's default mirror below), so we call
      // captureTool explicitly instead of double-writing both shapes for the
      // same content (task-1a6da52a3017 "Brain C1").
      await addSiteMemory(site, text, { kind: 'flow', skipBrain: true });
      saved = true;
      online = true;
      // Brain C1: propose the recorded flow as a candidate reusable tool —
      // fire-and-forget, never blocks/throws into the recording stop path.
      // The formatted skill text IS the "code" (a numbered selector/step
      // sequence) built from selectors + placeholder KEYS only (formatSkill),
      // same NON-PHI guarantee as the site-memory write above.
      captureTool(text, `Recorded browser flow${opts.skillName ? `: ${opts.skillName}` : ''} on ${site}`, {
        domain: site,
      });
    } catch {
      // Offline / server unreachable / rejected — keep the recording on THIS
      // machine as the offline cache so it isn't lost. A later online recall
      // serves the canonical store; this is the local fallback only.
      try {
        addMemory('site', site, text);
        saved = true;
      } catch {
        saved = false;
      }
    }
  }
  return { ok: true, actions, site, saved, online };
}

/** Derive the site key (host) for the recording from its first action url. */
function deriveSite(actions: RecordedAction[]): string {
  for (const a of actions) {
    try {
      return new URL(a.url).hostname;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

/** Render a recorded session as a NON-PHI how-to note for the site memory. The
 *  placeholder is a KEY (field identity), never a value. */
export function formatSkill(name: string | undefined, actions: RecordedAction[]): string {
  const lines: string[] = [];
  lines.push(`Recorded flow${name ? `: ${name}` : ''} (${actions.length} step${actions.length === 1 ? '' : 's'})`);
  actions.forEach((a, i) => {
    const sel = a.best ? `${a.best.kind}=${a.best.selector}` : '(no stable selector)';
    const where = a.placeholder ? ` field=${a.placeholder}` : '';
    const verb = a.action === 'navigate' ? `navigate ${a.url}` : `${a.action} ${sel}${where}`;
    lines.push(`${i + 1}. ${verb}`);
  });
  return lines.join('\n');
}

/** Snapshot the in-progress recording (for live UI / debugging). */
export function currentRecording(): { recording: boolean; count: number; webContentsId: number | null } {
  return {
    recording: active != null,
    count: active ? active.actions.length : 0,
    webContentsId: active ? active.webContentsId : null,
  };
}
