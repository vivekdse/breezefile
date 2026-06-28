// Pre-fetched task-context bundle (task-9bd1389e64c6).
//
// GOAL: make starting a task FAST by handing the browser/operator session ALL
// the standing context it needs in ONE shot at launch — so the agent does NOT
// make several discovery MCP round-trips (recall_site / recall_task / "what
// sites matter for this task") before it can act.
//
// THE DESIGN (the user's proposal):
//   - At/after task CREATION, a process determines the RELEVANT websites / pages
//     for the task (not "associated memories" directly).
//   - Those relevant sites are the KEY used to pull ASSOCIATED MEMORIES — the
//     TypeBuild MCP already has recall_site/remember_site and recall_task/
//     remember_task, so site → memories is a LOOKUP, not an LLM guess each time.
//   - At session start the WHOLE bundle (relevant sites + their site-memories +
//     any task-level recalled context) is injected DIRECTLY into the agent's
//     initial context.
//
// WHERE THE WORK RUNS (decisions 1 & 2):
//   1. Relevant-site detection + the site→memory / task-recall lookups run
//      SERVER-SIDE, ASYNCHRONOUSLY right after create_task, and the result is
//      CACHED server-side keyed by the (opaque, non-PHI) task id. The CLIENT
//      does NOT run detection or call recall_* itself — keeping both create AND
//      launch fast. The client's job is a single GET of the prepared bundle.
//   2. This module is that single GET. It mirrors fetchOperatorInstructions
//      (electron/typebuild/operator-instructions.ts) exactly: Firebase-authed
//      fetch in MAIN, an on-disk cache so an OFFLINE launch still gets the
//      last-synced bundle, and a rendered Markdown body the launcher injects via
//      `--append-system-prompt` (the SAME injection seam operator-instructions
//      uses). Zero extra discovery round-trips once the bundle is present.
//
// PHI-SAFETY (decision 3, load-bearing):
//   Relevant sites and their memories are SHARED / NON-PHI standing knowledge
//   (which portal, which page, "the login is under Account → Sign in", selector
//   notes). They are NOT the task body. The task title/body stay PHI and live in
//   the conversation only — they are NEVER part of this bundle, the disk cache,
//   or any log. We never log the body; we only ever handle the opaque task id.
//   The server PHI-guards what it puts in the bundle (same 422 discipline as the
//   skills/memory writes); this client treats the bundle as opaque NON-PHI text.
//
// SERVER DEPENDENCY (NOT built in this repo — see follow-up task):
//   GET /chromeext/<id>/context-bundle
//     → 200 { task_id, version, ready, body, sites?, generated_at }
//        body    : rendered NON-PHI Markdown ready to inject (sites + their
//                  memories + task-level recall). '' when nothing applies.
//        ready   : false while async detection is still running (the client then
//                  simply injects nothing this launch — no blocking, no spin).
//        sites   : OPTIONAL machine-readable list (hostnames/urls) the bundle was
//                  built from; informational, the launcher injects `body`.
//     → 404 when the task isn't visible / has no bundle yet.
//   The endpoint is a pure LOOKUP of the server-prepared cache — it must NOT do
//   detection inline (that would re-introduce the latency this feature removes).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { API_BASE, typebuildFetch } from './task-data';

/** The shape the launcher consumes. `body` is rendered NON-PHI Markdown ready to
 *  inject; `ready` is false when the server's async detection hasn't finished
 *  (caller injects nothing); `offline` is true when served from the disk cache. */
export interface TaskContextBundle {
  taskId: string;
  version: number;
  ready: boolean;
  body: string;
  /** Hostnames/urls the bundle was built from (informational, may be empty). */
  sites: string[];
  offline: boolean;
}

/** On-disk cache of the last-synced bundle, by task id. Override the root with
 *  $BREEZE_MEMORY_DIR (tests). OFFLINE fallback only — same root + discipline as
 *  operator-instructions. The cached file is NON-PHI (sites + shared memories);
 *  the task body is never written here. */
function cacheFile(taskId: string): string {
  const root =
    process.env.BREEZE_MEMORY_DIR || path.join(os.homedir(), '.breezefile', 'memory');
  const safe = String(taskId || 'unknown').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(root, 'task-context-bundle', safe + '.md');
}

function writeCache(taskId: string, body: string): void {
  try {
    const f = cacheFile(taskId);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  } catch {
    /* cache is best-effort */
  }
}

function readCache(taskId: string): string {
  try {
    return readFileSync(cacheFile(taskId), 'utf8');
  } catch {
    return '';
  }
}

/** Fetch the pre-prepared context bundle for a task (single GET, server-cached).
 *
 *  Returns a body of rendered NON-PHI Markdown the launcher injects as a
 *  system-prompt addendum. On a successful fetch with a non-empty body we refresh
 *  the disk cache and return the live body; when the server is unreachable we
 *  serve the cached copy (offline:true). When the server's async detection isn't
 *  finished yet (ready:false) or the task has no bundle (404), the body is '' and
 *  the launcher injects nothing — never blocking the launch. Never logs the body;
 *  only the opaque task id is ever handled. */
export async function fetchTaskContextBundle(taskId: string): Promise<TaskContextBundle> {
  const empty: TaskContextBundle = {
    taskId,
    version: 0,
    ready: false,
    body: '',
    sites: [],
    offline: false,
  };
  if (!taskId) return empty;

  try {
    const res = await typebuildFetch(
      `${API_BASE}/chromeext/${encodeURIComponent(taskId)}/context-bundle`,
    );
    // 404 → no bundle for this task yet. Treat as "nothing to inject" rather than
    // an error: the launch proceeds, the agent falls back to live discovery.
    if (res.status === 404) return empty;
    if (!res.ok) throw new Error(`context-bundle fetch failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      task_id?: string;
      version?: number;
      ready?: boolean;
      body?: string;
      sites?: unknown;
    };
    const ready = data.ready !== false; // default true when the server omits it
    const body = ready ? String(data.body ?? '') : '';
    const sites = Array.isArray(data.sites)
      ? data.sites.filter((s): s is string => typeof s === 'string')
      : [];
    // Only overwrite the cache when the server actually has a ready, non-empty
    // bundle — a not-ready / empty response must not wipe a good cached copy.
    if (ready && body) writeCache(taskId, body);
    return {
      taskId: data.task_id || taskId,
      version: Number(data.version ?? 0),
      ready,
      body,
      sites,
      offline: false,
    };
  } catch {
    // Unreachable / parse failure — serve the cached copy if we have one. A
    // present cache is by definition a previously-ready bundle, so ready:true.
    const cached = readCache(taskId);
    return {
      taskId,
      version: 0,
      ready: !!cached,
      body: cached,
      sites: [],
      offline: true,
    };
  }
}

/** Wrap a bundle body for injection as a system-prompt addendum. Returns '' when
 *  the body is empty so the caller can spread it conditionally (mirrors how
 *  operator-instructions is injected). The heading tells the agent this is
 *  pre-fetched standing context so it does NOT re-run recall_site/recall_task. */
export function renderBundleAddendum(bundle: TaskContextBundle): string {
  const body = bundle.body.trim();
  if (!body) return '';
  return [
    '# Pre-fetched task context (relevant sites + memories)',
    '',
    'The following NON-PHI context was gathered up front from the relevant sites',
    'for this task and their associated memories. Treat it as already-recalled:',
    'use it directly and do NOT make extra recall_site / recall_task discovery',
    'calls for this same context before acting.',
    '',
    body,
  ].join('\n');
}
