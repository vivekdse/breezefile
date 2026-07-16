// Brain client (task-35dde066caf7 "Brain C5") — direct calls to the dedicated
// brain_api service (federated multi-tenant agentic-memory, epic
// task-8913f9bc2230). NOT the same origin as TypeBuild's task_manager_api
// (API_BASE / typebuildFetch in ./task-data): the brain is a SEPARATE service,
// currently run locally (`run-brain.sh`, gunicorn on 127.0.0.1:8100) with no
// public domain provisioned yet. BRAIN_BASE is overridable via
// $BREEZE_BRAIN_BASE for when it does get one (or for tests).
//
// Auth (verified live against brain_api/api.py `require_brain_user`):
//   Authorization: Bearer <authkit-issued token>   — same identity as the rest
//     of the platform (authkit), so the operator's existing token works; no
//     separate brain login.
//   X-Brain-Tenant: <business_id>                  — REQUIRED only when the
//     principal reaches more than one tenant; omitted when there's exactly
//     one (the server resolves it alone). We always send it when known so a
//     multi-tenant operator never hits the 400 "specify which tenant" case.
//
// Endpoints this module wires (read-side, S4 — verified live via real HTTP):
//   POST /brain/tools/fetch   { tool_id? | signature? }  -> MemoryRowOut | null
//   POST /brain/recall        { query, scope?, filters?, top_k? } -> MemoryRowOut[]
//   POST /brain/context       { task_type?, domain?, url?, entities?, task_id?,
//                                target_tokens? } -> ContextBundleOut
//     (assembleContext below belongs to the separate C2 task, task-8f71349656db
//     — the anticipatory-planner launch bundle. It lives in this module because
//     it shares BrainMemoryRow/asRow/authHeaders with get_tool/recall; C5's own
//     scope is get_tool + recall + the tier/confidence display helpers below.)
//
// Endpoints this module deliberately does NOT wire (per read of brain_api's
// api.py at the time of writing): there is NO confirm/reject/promote HTTP
// endpoint. Promotion candidate -> active is CURATOR-driven only (S6, an async
// sweep loop). Do not invent one client-side — see brain-confirm.ts, which
// implements the client-only "auto-confirm" convention instead (record_observation
// already lands rows as candidates; there is nothing today for a client to POST
// to explicitly promote one).
//
// NON-PHI: every field here is operational how-to / tool code, never a task
// body or PHI value.

import { getIdToken } from './auth';
import { fetchWithTimeout } from './http';

/** Base URL of the brain_api service. Not yet behind a public domain — override
 *  with $BREEZE_BRAIN_BASE (e.g. for a tunnel, or a test stub). */
export const BRAIN_BASE = process.env.BREEZE_BRAIN_BASE || 'http://127.0.0.1:8100';

/** The three tiers a MemoryRow can come from (doc §2.2 "three tiers of
 *  isolation"). Mirrors brain_api's `tier` column values exactly (lowercase on
 *  the wire; we upper-case only for display, see brain-tier-label below). */
export type BrainTier = 'global' | 'org' | 'task';

/** Serialisable MemoryRowOut, mirrored field-for-field from brain_api's
 *  api.py `MemoryRowOut` Pydantic model. Every field here is NON-PHI. */
export interface BrainMemoryRow {
  id: string;
  tier: BrainTier;
  content: string;
  summary?: string | null;
  artifact?: string | null;
  hit_rate?: number | null;
  downstream_success_rate?: number | null;
  staleness_score: number;
  avg_latency_ms?: number | null;
  vec_distance: number;
  composite_score: number;
  source_rank: number;
}

function authHeaders(idToken: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${idToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (tenantId) headers['X-Brain-Tenant'] = tenantId;
  return headers;
}

function asRow(value: unknown): BrainMemoryRow | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.tier !== 'string') return null;
  return {
    id: v.id,
    tier: v.tier as BrainTier,
    content: String(v.content ?? ''),
    summary: (v.summary as string | null) ?? null,
    artifact: (v.artifact as string | null) ?? null,
    hit_rate: (v.hit_rate as number | null) ?? null,
    downstream_success_rate: (v.downstream_success_rate as number | null) ?? null,
    staleness_score: Number(v.staleness_score ?? 0),
    avg_latency_ms: (v.avg_latency_ms as number | null) ?? null,
    vec_distance: Number(v.vec_distance ?? 0),
    composite_score: Number(v.composite_score ?? 0),
    source_rank: Number(v.source_rank ?? 0),
  };
}

/** Direct fetch of a stored generalized tool artifact by id or signature
 *  (POST /brain/tools/fetch — the `get_tool` primitive from the epic doc).
 *  Exactly one of {toolId, signature} must be given (server 422s otherwise;
 *  we validate client-side too so a bad call fails fast without a round-trip).
 *  Returns null on a 404-shaped "not found" (server returns `null` body, HTTP
 *  200) or on any transport failure — a missing tool must never block the
 *  operator, it just means "nothing generalized yet, fall back to discovery." */
export async function getTool(
  opts: { toolId?: string; signature?: string; tenantId?: string },
): Promise<BrainMemoryRow | null> {
  const { toolId, signature, tenantId } = opts;
  if ((!toolId && !signature) || (toolId && signature)) {
    throw new Error('getTool: provide exactly one of toolId or signature');
  }
  try {
    const idToken = await getIdToken();
    const res = await fetchWithTimeout(`${BRAIN_BASE}/brain/tools/fetch`, {
      method: 'POST',
      headers: authHeaders(idToken, tenantId),
      body: JSON.stringify({ tool_id: toolId ?? null, signature: signature ?? null }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return asRow(data);
  } catch {
    // Unreachable brain / bad token — degrade to "no tool found", never throw
    // into the operator's launch path.
    return null;
  }
}

/** One layer of a ContextBundleOut (brain_api's `ContextLayerOut`): a tier name
 *  plus the ranked rows the budgeter kept for it. */
export interface BrainContextLayer {
  tier: BrainTier;
  rows: BrainMemoryRow[];
}

/** The layered, token-budgeted bundle POST /brain/context returns — mirrors
 *  brain_api's `ContextBundleOut` field-for-field. `candidateSites` is the
 *  Brain #7 fold: when the caller didn't name a domain/url, the server infers
 *  which site(s) the task's other facets point at (ordered, most relevant
 *  first) so the operator can resolve "which portal" without guessing. */
export interface BrainContextBundle {
  globalTools: BrainContextLayer;
  siteMemory: BrainContextLayer;
  tenantRules: BrainContextLayer;
  taskNotes: BrainContextLayer;
  candidateSites: string[];
  allRows: BrainMemoryRow[];
  tokenCount: number;
}

/** Facets the anticipatory planner extracts from a just-landed task, ALL
 *  NON-PHI (task-8f71349656db "Brain C2"). `taskType`/`domain`/`url`/`entities`
 *  are routing/classification labels (a template slug, a registrable domain, a
 *  start URL, code/payer-name style entity labels) — never the task title/body,
 *  which stay PHI and are never sent here. `taskId` scopes the `task_notes`
 *  tier to this specific run. */
export interface AssembleContextFacets {
  taskType?: string;
  domain?: string;
  url?: string;
  entities?: string[];
  taskId?: string;
  targetTokens?: number;
  tenantId?: string;
}

const EMPTY_LAYER = (tier: BrainTier): BrainContextLayer => ({ tier, rows: [] });

/** Empty bundle returned on any failure — the launch must never block on the
 *  brain being unreachable; the operator just falls back to live discovery
 *  exactly as it does today without this feature. */
function emptyBundle(): BrainContextBundle {
  return {
    globalTools: EMPTY_LAYER('global'),
    siteMemory: EMPTY_LAYER('global'),
    tenantRules: EMPTY_LAYER('org'),
    taskNotes: EMPTY_LAYER('task'),
    candidateSites: [],
    allRows: [],
    tokenCount: 0,
  };
}

function asLayer(value: unknown, fallbackTier: BrainTier): BrainContextLayer {
  if (!value || typeof value !== 'object') return EMPTY_LAYER(fallbackTier);
  const v = value as Record<string, unknown>;
  const rows = Array.isArray(v.rows)
    ? v.rows.map(asRow).filter((r): r is BrainMemoryRow => r !== null)
    : [];
  const tier = typeof v.tier === 'string' ? (v.tier as BrainTier) : fallbackTier;
  return { tier, rows };
}

/** Pre-execution anticipatory planner (POST /brain/context) — task-8f71349656db
 *  "Brain C2". Called IMMEDIATELY when a task lands, from its extracted NON-PHI
 *  facets, so the run starts already oriented with relevant historical memory
 *  and mapped target domains instead of discovering as it goes. Returns an
 *  empty, zero-row bundle (never throws) on any failure — a brain outage must
 *  degrade to today's live-discovery behavior, not block or fail the launch. */
export async function assembleContext(
  facets: AssembleContextFacets,
): Promise<BrainContextBundle> {
  try {
    const idToken = await getIdToken();
    const res = await fetchWithTimeout(`${BRAIN_BASE}/brain/context`, {
      method: 'POST',
      headers: authHeaders(idToken, facets.tenantId),
      body: JSON.stringify({
        task_type: facets.taskType ?? null,
        domain: facets.domain ?? null,
        url: facets.url ?? null,
        entities: facets.entities?.length ? facets.entities : null,
        task_id: facets.taskId ?? null,
        target_tokens: facets.targetTokens ?? 4096,
      }),
    });
    if (!res.ok) return emptyBundle();
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return emptyBundle();
    const allRows = Array.isArray(data.all_rows)
      ? data.all_rows.map(asRow).filter((r): r is BrainMemoryRow => r !== null)
      : [];
    const candidateSites = Array.isArray(data.candidate_sites)
      ? data.candidate_sites.filter((s): s is string => typeof s === 'string')
      : [];
    return {
      globalTools: asLayer(data.global_tools, 'global'),
      siteMemory: asLayer(data.site_memory, 'global'),
      tenantRules: asLayer(data.tenant_rules, 'org'),
      taskNotes: asLayer(data.task_notes, 'task'),
      candidateSites,
      allRows,
      tokenCount: Number(data.token_count ?? 0),
    };
  } catch {
    // Unreachable brain / bad token — degrade to the empty bundle, never throw
    // into the operator's launch path.
    return emptyBundle();
  }
}

/** Mid-run hybrid recall (POST /brain/recall) — what the launch bundle missed.
 *  NON-PHI free-text query only. Returns [] (never throws) on any failure so a
 *  recall miss degrades to "nothing extra found," matching the client's
 *  existing site-memory recall discipline (site-memory.ts). */
export async function recall(
  query: string,
  opts: {
    scope?: string;
    filters?: Record<string, unknown>;
    topK?: number;
    tenantId?: string;
  } = {},
): Promise<BrainMemoryRow[]> {
  if (!query.trim()) return [];
  try {
    const idToken = await getIdToken();
    const res = await fetchWithTimeout(`${BRAIN_BASE}/brain/recall`, {
      method: 'POST',
      headers: authHeaders(idToken, opts.tenantId),
      body: JSON.stringify({
        query,
        scope: opts.scope ?? null,
        filters: opts.filters ?? null,
        top_k: opts.topK ?? 10,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => []);
    return Array.isArray(data)
      ? data.map(asRow).filter((r): r is BrainMemoryRow => r !== null)
      : [];
  } catch {
    return [];
  }
}

/** Human-readable label for a tier, for UI display (site-notes list, tool
 *  picker). Matches the epic doc's naming: GLOBAL / ORG (tenant) / TASK. */
export function tierLabel(tier: BrainTier | string): string {
  switch (tier) {
    case 'global':
      return 'Global';
    case 'org':
      return 'Org';
    case 'task':
      return 'Task';
    default:
      return String(tier || 'Unknown');
  }
}

/** Short description of what each tier means, for a tooltip/legend. */
export function tierDescription(tier: BrainTier | string): string {
  switch (tier) {
    case 'global':
      return 'Shared across every business on the network';
    case 'org':
      return "Scoped to your organization only";
    case 'task':
      return 'Scoped to this task/run only';
    default:
      return '';
  }
}

/** A single 0-1 confidence/quality score derived from the scoring fields the
 *  brain returns (hit_rate, downstream_success_rate, staleness_score,
 *  composite_score — brain_api's MemoryRowOut). There is no single canonical
 *  "confidence" field on the wire, so this combines the signals the curator
 *  already computes:
 *    - composite_score is the curator's own ranking signal (retrieval-quality
 *      weighted blend) — the strongest single indicator, so it anchors the
 *      score directly (already ~0-1 in practice per brain_api/retrieval.py).
 *    - hit_rate / downstream_success_rate (when present) nudge it up or down —
 *      a row the curator has real usage evidence for should read as more or
 *      less trustworthy than a fresh, unproven one.
 *    - staleness_score (0=fresh..1=stale in brain_api's convention) discounts
 *      the result — a stale row should never present as high-confidence even
 *      if its composite_score was good when computed.
 *  This is a DISPLAY heuristic only — the server remains the source of truth
 *  for ranking; we never re-rank rows client-side, only label them. */
export function confidenceScore(row: BrainMemoryRow): number {
  let score = clamp01(row.composite_score);
  if (typeof row.hit_rate === 'number') {
    score = score * 0.7 + clamp01(row.hit_rate) * 0.3;
  }
  if (typeof row.downstream_success_rate === 'number') {
    score = score * 0.7 + clamp01(row.downstream_success_rate) * 0.3;
  }
  const staleness = clamp01(row.staleness_score);
  score *= 1 - staleness * 0.5; // stale rows lose up to half their confidence
  return clamp01(score);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Bucket a confidence score into a small label set for a compact badge,
 *  mirroring how the rest of the app favors short text badges over raw
 *  numbers in list rows (see TaskIndicators.tsx). */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}
