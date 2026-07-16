// Shared, ONLINE browser-automation memory (task-3c9b1146cee2; per-task scope
// added in task-f2639aa68585).
//
// The browser agent accumulates durable, NON-PHI how-to about web pages —
// selectors, fast paths, gotchas, reusable code — AND per-task learnings (the
// quirks of running one TypeBuild task / task type). This used to live in a
// per-machine JSON store (electron/browser/tools/memory.mjs). It now rides the
// SHARED online store so every machine + teammate sees the same learnings:
//
//   server-canonical  GET/POST/DELETE /chromeext/site-memory   (chromeext.py)
//   local cache       ~/.breezefile/memory/sites/<domain>.json (offline read)
//   local cache       ~/.breezefile/memory/tasks/<task_tag>.json (offline read)
//
// The CLI subprocess that the agent runs (`breeze-tools memory ...`) holds NO
// Firebase token, so — exactly like cli.mjs `fill-ref` → /app/task-data — it
// reaches the online store THROUGH Breeze main's localhost control API
// (electron/api-server.ts `/app/site-memory`), which proxies here with the real
// token via typebuildFetch. Main is the only process that talks to the server.
//
// PHI invariant (non-negotiable): site memory is a SHARED, NON-PHI surface —
// selectors / paths / how-to / code only, NEVER a typed-in value. The server
// PHI-guards every write (422 on PHI-shaped text); we never log a body.
//
// SCOPE MAPPING. The local store had two scopes: `site` (keyed by domain) and
// `task` (keyed by an opaque task id). BOTH now have a server home
// (task-f2639aa68585 — supersedes the earlier per-site-only task-3c9b1146cee2):
//   - site → /chromeext/site-memory, keyed by the normalized registrable domain
//            (an exact fit).
//   - task → /chromeext/site-memory, keyed by `task_tag` (a task id or task-type
//            tag). The server was extended 2026-06-27 to accept `task_tag` as a
//            FIRST-CLASS keying dimension alongside `domain` (POST + GET), so
//            per-task learnings are now SHARED ONLINE too — the gap that pinned
//            `task` memory to local-only is CLOSED. `task_tag` is NOT normalized
//            to a domain, so distinct task ids no longer collapse into one bucket.
// At least one of domain/task_tag/tag is required by the server (the keying
// dimension). The on-disk JSON remains an OFFLINE CACHE for both scopes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import { API_BASE, typebuildFetch } from './task-data';
import {
  confidenceLevel,
  confidenceScore,
  recall as brainRecall,
  tierDescription,
  tierLabel,
  type BrainMemoryRow,
  type BrainTier,
  type ConfidenceLevel,
} from './brain-client';
// RUNTIME edge capture (task-1a6da52a3017 "Brain C1"): stream writes to the
// brain DURING a run, never blocking on curation. See the "Brain edge capture"
// section below for the non-blocking wrappers every call site should use
// instead of brain-writes.ts directly.
import {
  link as brainLink,
  proposeTool as brainProposeTool,
  recordObservation as brainRecordObservation,
  type BrainWriteResult,
} from './brain-writes';

/** Root of the local cache (mirrors memory.mjs memoryDir()). Override with
 *  $BREEZE_MEMORY_DIR (tests). Server is canonical; this is the offline read. */
function memoryDir(): string {
  return process.env.BREEZE_MEMORY_DIR || path.join(stateDir(), 'memory');
}

/** Which keying dimension a cached bucket lives under. `site` buckets cache
 *  under sites/<domain>.json; `task` buckets under tasks/<task_tag>.json. */
type CacheScope = 'site' | 'task';

function cacheFileFor(scope: CacheScope, key: string): string {
  // The key is already normalized server-side; sanitize for a safe filename.
  const safe = String(key || '').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(memoryDir(), scope === 'task' ? 'tasks' : 'sites', safe + '.json');
}

/** One shared site-memory note (the NON-PHI fields we consume).
 *
 *  task-35dde066caf7 ("Brain C5"): notes can now come from TWO stores —
 *    - the legacy chromeext /chromeext/site-memory sqlite store (no tier
 *      concept; `tier`/scoring fields below are absent for these notes), and
 *    - the Brain's tiered, curated knowledge (brain-client.ts `recall`/
 *      `getTool`), which DOES carry a tier (global/org/task) and quality
 *      signals. The optional fields below let ONE rendering surface show both
 *      uniformly — present only for brain-sourced notes. See
 *      brainRowToSiteNote() for the mapping and mergeBrainNotes() for pulling
 *      brain recall results alongside the legacy store's notes. */
export interface SiteNote {
  id: string;
  domain: string;
  /** Per-task key when the note was keyed by task rather than domain. */
  task_tag?: string | null;
  kind: string;
  body: string;
  url_pattern?: string | null;
  updated_at?: string | null;
  /** Brain-sourced notes only: which of the three isolation tiers this came
   *  from (doc §2.2) — global (cross-org), org (this tenant), or task (this
   *  run only). Absent for legacy chromeext notes (no tier concept there). */
  tier?: BrainTier;
  /** Human label/description for `tier`, precomputed so the renderer doesn't
   *  need to import brain-client just to label a badge. */
  tierLabel?: string;
  tierDescription?: string;
  /** Brain-sourced notes only: a 0-1 confidence/quality indicator derived from
   *  the brain's scoring fields (hit_rate, downstream_success_rate,
   *  staleness_score, composite_score — see brain-client.ts confidenceScore).
   *  Display-only; the brain remains the ranking source of truth. */
  confidence?: number;
  confidenceLevel?: ConfidenceLevel;
  /** Which store this note came from — lets the UI badge legacy vs brain notes
   *  distinctly if it wants to, without inferring it from tier's presence. */
  source?: 'chromeext' | 'brain';
}

/** Map one brain MemoryRow (from recall/get_tool) into the shared SiteNote
 *  shape so the existing site-notes UI can render brain-sourced knowledge
 *  alongside legacy chromeext notes with no separate code path. ACTIVE only:
 *  every row recall()/getTool() can return is already active — see
 *  brain-client.ts and brain_api's assemble_context/recall docstrings
 *  ("Returns only active (curated) rows"). */
export function brainRowToSiteNote(row: BrainMemoryRow, domain = ''): SiteNote {
  const score = confidenceScore(row);
  return {
    id: row.id,
    domain,
    kind: row.artifact ? 'tool' : 'memory',
    body: row.summary || row.content,
    url_pattern: row.artifact ?? null,
    updated_at: null,
    tier: row.tier,
    tierLabel: tierLabel(row.tier),
    tierDescription: tierDescription(row.tier),
    confidence: score,
    confidenceLevel: confidenceLevel(score),
    source: 'brain',
  };
}

function asNotes(value: unknown): SiteNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => ({
      id: String(n.id ?? ''),
      domain: String(n.domain ?? ''),
      task_tag: (n.task_tag as string | null) ?? null,
      kind: String(n.kind ?? 'note'),
      body: String(n.body ?? ''),
      url_pattern: (n.url_pattern as string | null) ?? null,
      updated_at: (n.updated_at as string | null) ?? null,
    }));
}

/** Write the recalled notes to the local cache so a later OFFLINE recall still
 *  has something to inject. Best-effort: a cache write must never fail a recall.
 *  PHI-safe: site memory is NON-PHI by construction (server PHI-guards writes). */
function writeCache(scope: CacheScope, key: string, notes: SiteNote[]): void {
  try {
    const f = cacheFileFor(scope, key);
    mkdirSync(path.dirname(f), { recursive: true });
    const meta = scope === 'task' ? { task_tag: key } : { domain: key };
    writeFileSync(f, JSON.stringify({ ...meta, notes }, null, 2) + '\n');
  } catch {
    /* cache is best-effort */
  }
}

function writeSiteCache(domain: string, notes: SiteNote[]): void {
  writeCache('site', domain, notes);
}

/** Read the local cache for a (scope, key) bucket (offline fallback). [] on miss. */
function readCache(scope: CacheScope, key: string): SiteNote[] {
  try {
    const data = JSON.parse(readFileSync(cacheFileFor(scope, key), 'utf8'));
    return asNotes(data.notes);
  } catch {
    return [];
  }
}

function readSiteCache(domain: string): SiteNote[] {
  return readCache('site', domain);
}

// ─── Brain edge capture (task-1a6da52a3017 "Brain C1") ─────────────────────
//
// The operator streams captures to the brain DURING a run, never blocking on
// curation: write locally first (fast, always available — the cache helpers
// above), then forward to the brain API ASYNCHRONOUSLY. If the brain call
// fails (network, 401, PHI rejection, whatever) we log and continue — the
// local write and the run itself are never at risk.
//
// `tier` is 'org' or 'task' ONLY: an edge caller never writes 'global' (only
// the curator promotes there, via its own async sweep). Callers pick:
//   - 'task' for anything scoped to just this run (a one-off DOM shape, a
//     failure seen only in this execution, a metric for this run).
//   - 'org' for anything this tenant should keep seeing across future runs
//     (a durable site quirk, a reusable workaround, a human correction that
//     will recur).
//
// Every wrapper below returns void — it never blocks or throws into the
// caller's control flow. Failures are logged (console.warn) with NO body
// content, matching the addSiteMemory/addTaskMemory "never log a body"
// discipline above.

function logBrainWriteFailure(op: string, result: BrainWriteResult): void {
  // NON-PHI: reason/status/hits are heuristic labels, never the body/code we
  // sent. `hits` (PHI reason only) are category names (e.g. "ssn", "dob"),
  // not the flagged text itself.
  if (result.reason === 'phi') {
    console.warn(`[brain] ${op} rejected (PHI-shaped text)`, { hits: result.hits });
  } else {
    console.warn(`[brain] ${op} failed`, { reason: result.reason, status: result.status });
  }
}

/** Options common to every capture call: which tenant/run this write is under. */
export interface BrainCaptureContext {
  tenantId?: string;
  taskId?: string;
  projectId?: string;
}

/** Fire-and-forget: record a NON-PHI observation (novel env, failure state,
 *  DOM shape, human correction, execution metric — anything worth the brain
 *  remembering that isn't a reusable tool/code path). Runs async; never
 *  awaited by the caller, never throws, logs (no body) on failure. */
export function captureObservation(
  kind: 'memory' | 'tool',
  body: string,
  opts: BrainCaptureContext & {
    tier?: 'org' | 'task';
    domain?: string;
    urlPattern?: string;
    summary?: string;
    evidence?: Record<string, unknown>;
  } = {},
): void {
  void brainRecordObservation({
    tier: opts.tier ?? (opts.taskId ? 'task' : 'org'),
    kind,
    body,
    domain: opts.domain,
    urlPattern: opts.urlPattern,
    taskId: opts.taskId,
    projectId: opts.projectId,
    summary: opts.summary,
    evidence: opts.evidence,
    tenantId: opts.tenantId,
  })
    .then((r) => {
      if (!r.ok) logBrainWriteFailure('record_observation', r);
    })
    .catch(() => {
      /* recordObservation itself never throws; this is defense in depth */
    });
}

/** Fire-and-forget: propose a candidate reusable tool/workaround the run just
 *  discovered (code + a human-readable description of what it does). Lands as
 *  status='candidate' — the curator decides whether it generalizes further.
 *  Runs async; never throws, logs (no body) on failure. */
export function captureTool(
  code: string,
  context: string,
  opts: BrainCaptureContext & { domain?: string; evidence?: Record<string, unknown> } = {},
): void {
  void brainProposeTool({
    code,
    context,
    domain: opts.domain,
    evidence: opts.evidence,
    tenantId: opts.tenantId,
  })
    .then((r) => {
      if (!r.ok) logBrainWriteFailure('propose_tool', r);
    })
    .catch(() => {
      /* proposeTool itself never throws; defense in depth */
    });
}

/** Fire-and-forget: link two memory nodes with a directed relation (e.g. this
 *  carrier <-> this exception, this tool <-> this portal version) — the agent
 *  noticing a relationship mid-run. Runs async; never throws, logs on failure.
 *  Both node ids must already exist (typically ids echoed back by a prior
 *  captureObservation/captureTool call in the SAME run). */
export function captureLink(
  fromId: string,
  toId: string,
  relation: string,
  opts: BrainCaptureContext & { weight?: number } = {},
): void {
  void brainLink({
    fromId,
    toId,
    relation,
    weight: opts.weight,
    tenantId: opts.tenantId,
  })
    .then((r) => {
      if (!r.ok) logBrainWriteFailure('link', r);
    })
    .catch(() => {
      /* link itself never throws; defense in depth */
    });
}

/** Recall the shared notes for a page (domain or full URL). Server-canonical;
 *  on a transport/HTTP failure (offline) we serve the local cache instead so a
 *  session start still gets whatever was last synced. The server normalizes the
 *  domain to its registrable form, so a full URL recalls the right bucket. */
export async function recallSiteMemory(
  domain: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<{ domain: string; notes: SiteNote[]; offline: boolean }> {
  const params = new URLSearchParams({ domain });
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  try {
    const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory?${params}`);
    if (!res.ok) throw new Error(`site-memory recall failed (${res.status})`);
    const body = (await res.json().catch(() => ({}))) as { domain?: string; notes?: unknown };
    const norm = body.domain || domain;
    const notes = asNotes(body.notes);
    writeSiteCache(norm, notes);
    return { domain: norm, notes, offline: false };
  } catch {
    // Offline / server unreachable — serve the last-synced cache. We cache under
    // the server's normalized domain; the bare-domain read used at session start
    // matches that name in the common case.
    return { domain, notes: readSiteCache(domain), offline: true };
  }
}

/** Add a shared NON-PHI note. POSTs online (server PHI-guards: 422 on a value);
 *  on success we refresh the local cache for that domain. Throws on a non-2xx so
 *  the CLI surfaces the server's reason (e.g. the PHI rejection) to the agent —
 *  a learning we cannot share must NOT silently fall back to a local-only write.
 *  We never log the body. */
export async function addSiteMemory(
  domain: string,
  body: string,
  opts: { kind?: string; url_pattern?: string; tenantId?: string; skipBrain?: boolean } = {},
): Promise<{ ok: boolean; id?: string; note?: SiteNote }> {
  const payload: Record<string, string> = { domain, body };
  if (opts.kind) payload.kind = opts.kind;
  if (opts.url_pattern) payload.url_pattern = opts.url_pattern;
  const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    id?: string;
    note?: unknown;
    error?: string;
  };
  if (!res.ok) {
    // Surface the server's reason WITHOUT echoing the body we sent.
    throw Object.assign(new Error(data.error || `site-memory add failed (${res.status})`), {
      status: res.status,
    });
  }
  const note = asNotes([data.note])[0];
  // Refresh the cache so an immediate offline recall sees the new note.
  void recallSiteMemory(domain).catch(() => {});
  // Brain C1: write-through-buffer semantics — the legacy write above is the
  // fast, always-available local-first path (it just landed, cache refreshed);
  // now mirror it to the brain ASYNCHRONOUSLY as an 'org'-tier observation (a
  // site note is durable how-to, meant to recur across future runs on this
  // domain — not scoped to just one task). Never awaited, never blocks the
  // caller, failure is logged only (see captureObservation).
  if (!opts.skipBrain) {
    captureObservation('memory', body, {
      tier: 'org',
      domain,
      urlPattern: opts.url_pattern,
      tenantId: opts.tenantId,
    });
  }
  return { ok: true, id: data.id, note };
}

/** Recall the shared notes for a TASK (task-f2639aa68585). Same store + endpoint
 *  as recallSiteMemory, but keyed by `task_tag` (a task id or task-type tag)
 *  rather than a domain — the server does NOT normalize task_tag to a domain, so
 *  each task gets its own bucket. Offline → the tasks/<task_tag>.json cache. */
export async function recallTaskMemory(
  taskTag: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<{ task_tag: string; notes: SiteNote[]; offline: boolean }> {
  const params = new URLSearchParams({ task_tag: taskTag });
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  try {
    const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory?${params}`);
    if (!res.ok) throw new Error(`task-memory recall failed (${res.status})`);
    const body = (await res.json().catch(() => ({}))) as { task_tag?: string; notes?: unknown };
    const tag = body.task_tag || taskTag;
    const notes = asNotes(body.notes);
    writeCache('task', tag, notes);
    return { task_tag: tag, notes, offline: false };
  } catch {
    return { task_tag: taskTag, notes: readCache('task', taskTag), offline: true };
  }
}

/** Add a shared NON-PHI per-TASK note (task-f2639aa68585), keyed by `task_tag`.
 *  Same store + PHI-guard as addSiteMemory; the server guards the task_tag text
 *  too. Throws on a non-2xx so the CLI surfaces the server's reason. */
export async function addTaskMemory(
  taskTag: string,
  body: string,
  opts: { kind?: string; url_pattern?: string; tenantId?: string; skipBrain?: boolean } = {},
): Promise<{ ok: boolean; id?: string; note?: SiteNote }> {
  const payload: Record<string, string> = { task_tag: taskTag, body };
  if (opts.kind) payload.kind = opts.kind;
  if (opts.url_pattern) payload.url_pattern = opts.url_pattern;
  const res = await typebuildFetch(`${API_BASE}/chromeext/site-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    id?: string;
    note?: unknown;
    error?: string;
  };
  if (!res.ok) {
    // Surface the server's reason WITHOUT echoing the body we sent.
    throw Object.assign(new Error(data.error || `task-memory add failed (${res.status})`), {
      status: res.status,
    });
  }
  const note = asNotes([data.note])[0];
  void recallTaskMemory(taskTag).catch(() => {});
  // Brain C1: mirror to the brain as a 'task'-tier observation — scoped to
  // THIS run's task_tag, matching the local write's own scope. Async,
  // non-blocking, failure-logged-only (see captureObservation).
  if (!opts.skipBrain) {
    captureObservation('memory', body, {
      tier: 'task',
      taskId: taskTag,
      urlPattern: opts.url_pattern,
      tenantId: opts.tenantId,
    });
  }
  return { ok: true, id: data.id, note };
}

/** Delete one shared note by id. Throws on a non-2xx (e.g. 404 not found). */
export async function deleteSiteMemory(noteId: string): Promise<{ ok: boolean }> {
  const res = await typebuildFetch(
    `${API_BASE}/chromeext/site-memory/${encodeURIComponent(noteId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error || `site-memory delete failed (${res.status})`), {
      status: res.status,
    });
  }
  return { ok: true };
}

/** Recall a page's notes from BOTH stores and merge for the SiteNote surface
 *  (task-35dde066caf7 "Brain C5"): the legacy chromeext notes (recallSiteMemory
 *  above) PLUS the Brain's tiered, curated knowledge for the same domain
 *  (brain-client.ts `recall`, scoped by a `domain` filter). Brain rows are
 *  mapped via brainRowToSiteNote so tier + confidence render in the same list.
 *
 *  ACTIVE-ONLY GUARANTEE: brain_api's recall/assemble_context return only
 *  active (curated) rows by contract (never candidates) — see brain-client.ts
 *  and brain_api's api.py docstrings. So the notes returned here, and the
 *  cache written for them, mirror ACTIVE knowledge only; nothing CANDIDATE-
 *  tier ever reaches the on-disk cache through this path. A candidate a
 *  session just proposed (record_observation/propose_tool's echoed node_id)
 *  is handled separately by brain-confirm.ts and is NEVER written to this
 *  cache before the curator promotes it.
 *
 *  Best-effort: a brain recall failure (offline brain, no tenant resolved,
 *  etc.) never fails the overall call — it just contributes zero brain notes,
 *  same degrade-to-nothing discipline as brain-client.ts's own functions. */
export async function recallSiteMemoryWithBrain(
  domain: string,
  opts: { kind?: string; limit?: number; tenantId?: string } = {},
): Promise<{ domain: string; notes: SiteNote[]; offline: boolean }> {
  const legacy = await recallSiteMemory(domain, opts);
  let brainNotes: SiteNote[] = [];
  try {
    const rows = await brainRecall(domain, {
      filters: { domain },
      topK: opts.limit ?? 10,
      tenantId: opts.tenantId,
    });
    brainNotes = rows.map((r) => brainRowToSiteNote(r, domain));
  } catch {
    /* brain recall is best-effort; legacy notes still returned */
  }
  return {
    domain: legacy.domain,
    notes: [...brainNotes, ...legacy.notes],
    offline: legacy.offline,
  };
}
