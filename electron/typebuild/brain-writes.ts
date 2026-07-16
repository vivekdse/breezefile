// Brain write-side client (task-1a6da52a3017 "Brain C1" — client edge capture,
// epic task-8913f9bc2230). Wires the three S5 write endpoints verified live
// against brain_api/api.py:
//
//   POST /brain/observations  recordObservation()  — novel envs, failure
//     states, DOM shapes, human corrections, execution metrics.
//   POST /brain/tools         proposeTool()        — a candidate reusable
//     path/workaround the run just discovered (NOT yet promoted).
//   POST /brain/edges         link()               — a noticed relationship
//     between two memory nodes (e.g. this carrier <-> this exception, this
//     tool <-> this portal version).
//
// Same service/origin/auth as brain-client.ts (read-side): BRAIN_BASE + a
// Bearer authkit token via getIdToken() + an optional X-Brain-Tenant header.
// Kept in its OWN module rather than folded into brain-client.ts so this task
// (C1) and the concurrent C2/C5 work on that shared file don't collide on the
// same lines; the two modules share BRAIN_BASE (imported) and duplicate the
// tiny authHeaders() shape rather than reach into brain-client's unexported
// internals.
//
// EVERY write here is FIRE-AND-FORGET semantics for the caller: it resolves
// {ok:true, nodeId, duplicate} on success, or {ok:false, reason, status?,
// phi?, hits?} on ANY failure (network/timeout, 401/403, 422 PHI rejection,
// 422 tier error) — it NEVER throws. A brain write describes the run; it must
// never abort or slow the run itself. Callers that want local-first
// write-through + async forward semantics should go through
// site-memory.ts's captureToBrain() helper rather than call these directly
// mid-flow.
//
// PHI GUARD: enforced server-side (write_api.py) exactly like the existing
// chromeext site-memory guard (site-memory.ts's addSiteMemory/addTaskMemory) —
// a 422 with {"error": ..., "hits": [...]}. We mirror that same discipline
// here: never log the body/code/context we sent or the hits we got back
// (hits are heuristic category names, not the flagged text itself, but we
// still don't echo the source body into logs). Every field callers pass here
// must already be NON-PHI by construction (selectors, code, error shapes,
// domain labels) — this module does not add a client-side text scanner; the
// server is the enforcement point, same as every other write path in this repo.
//
// tenant identity: every write is authenticated (Bearer token) and MAY carry
// X-Brain-Tenant when the caller knows which business_id the run is under
// (multi-tenant principals); the server resolves it alone when the principal
// reaches exactly one tenant. Every call site in this module takes an
// optional `tenantId` and threads it through — same convention as
// brain-client.ts's getTool/recall/assembleContext.

import { getIdToken } from './auth';
import { fetchWithTimeout } from './http';
import { BRAIN_BASE, type BrainTier } from './brain-client';

function authHeaders(idToken: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${idToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (tenantId) headers['X-Brain-Tenant'] = tenantId;
  return headers;
}

/** Uniform result every write function here resolves to — never throws. */
export interface BrainWriteResult {
  ok: boolean;
  /** The memory_node id the server created/deduped to (observations/tools). */
  nodeId?: string;
  /** The edge id the server created (link only). */
  edgeId?: string;
  /** True when the server recognized this as a dup of an existing node and
   *  did not insert a new row (write_api.py's WriteResult.duplicate). */
  duplicate?: boolean;
  /** Present on any failure. Short, NON-PHI, safe to log:
   *    'network'  - transport/timeout/unreachable
   *    'auth'     - 401/403 (bad/expired token, tenant not reachable)
   *    'phi'      - 422 PHI-shaped-text rejection (see `hits`)
   *    'tier'     - 422 tier-boundary violation (e.g. attempted 'global')
   *    'invalid'  - 422/400 for any other validation reason
   *    'server'   - 5xx / unexpected shape
   */
  reason?: 'network' | 'auth' | 'phi' | 'tier' | 'invalid' | 'server';
  /** HTTP status, when we got one. */
  status?: number;
  /** PHI-guard heuristic category hits (chromeext-parity envelope), present
   *  only when reason === 'phi'. NEVER the flagged text itself. */
  hits?: string[];
}

function classifyStatus(status: number, errBody: unknown): BrainWriteResult {
  const body = (errBody && typeof errBody === 'object' ? errBody : {}) as {
    error?: string;
    hits?: unknown;
    detail?: string;
  };
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'auth', status };
  }
  if (status === 422) {
    const hits = Array.isArray(body.hits)
      ? body.hits.filter((h): h is string => typeof h === 'string')
      : undefined;
    if (hits) {
      // chromeext-parity PHI envelope: {"error", "hits"} — see api.py's _phi_422.
      return { ok: false, reason: 'phi', status, hits };
    }
    // Tier-boundary errors (BrainTierError, e.g. tier:'global') come back as a
    // plain HTTPException detail string, not the hits envelope.
    const detail = String(body.detail || body.error || '');
    if (/tier/i.test(detail)) return { ok: false, reason: 'tier', status };
    return { ok: false, reason: 'invalid', status };
  }
  if (status >= 500) return { ok: false, reason: 'server', status };
  return { ok: false, reason: 'invalid', status };
}

/** Success shape postBrain resolves to on a 2xx. BrainWriteResult.ok is plain
 *  `boolean` (not a literal), so `PostBrainOk | BrainWriteResult` doesn't
 *  discriminate on `.ok` alone — call sites additionally check `'data' in
 *  result` before touching `.data`. */
interface PostBrainOk {
  ok: true;
  status: number;
  data: Record<string, unknown>;
}

async function postBrain(
  path: string,
  payload: Record<string, unknown>,
  tenantId: string | undefined,
): Promise<PostBrainOk | BrainWriteResult> {
  let idToken: string;
  try {
    idToken = await getIdToken();
  } catch {
    return { ok: false, reason: 'auth' };
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BRAIN_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders(idToken, tenantId),
      body: JSON.stringify(payload),
    });
  } catch {
    // Unreachable brain / dead socket / timeout — never throw into the run.
    return { ok: false, reason: 'network' };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return classifyStatus(res.status, data);
  return { ok: true, status: res.status, data };
}

/** Record a NON-PHI memory observation (POST /brain/observations). Lands as
 *  status='candidate', invisible to retrieval until the curator promotes it.
 *  `tier` is 'org' or 'task' ONLY — a caller must never pass 'global' (only
 *  the curator promotes there); the server 422s a 'global' attempt anyway
 *  (BrainTierError) but we type it out so a caller can't even construct one. */
export async function recordObservation(opts: {
  tier: Exclude<BrainTier, 'global'>;
  kind: 'memory' | 'tool';
  body: string;
  domain?: string;
  urlPattern?: string;
  taskId?: string;
  projectId?: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  tenantId?: string;
}): Promise<BrainWriteResult> {
  const result = await postBrain(
    '/brain/observations',
    {
      tier: opts.tier,
      kind: opts.kind,
      body: opts.body,
      domain: opts.domain ?? null,
      url_pattern: opts.urlPattern ?? null,
      task_id: opts.taskId ?? null,
      project_id: opts.projectId ?? null,
      summary: opts.summary ?? null,
      evidence: opts.evidence ?? null,
    },
    opts.tenantId,
  );
  if (!result.ok || !('data' in result)) return result as BrainWriteResult;
  return {
    ok: true,
    nodeId: typeof result.data.node_id === 'string' ? result.data.node_id : undefined,
    duplicate: result.data.duplicate === true,
  };
}

/** Propose a candidate reusable tool (POST /brain/tools) — a discovered
 *  path/workaround, NOT yet promoted/generalized. Lands as kind='tool',
 *  status='candidate'; the curator alone decides whether it becomes an active
 *  global tool. `code` + `context` must be NON-PHI (selectors/steps/code, no
 *  secrets, no typed values) — the server PHI-guards it same as observations. */
export async function proposeTool(opts: {
  code: string;
  context: string;
  evidence?: Record<string, unknown>;
  domain?: string;
  tenantId?: string;
}): Promise<BrainWriteResult> {
  const result = await postBrain(
    '/brain/tools',
    {
      code: opts.code,
      context: opts.context,
      evidence: opts.evidence ?? null,
      domain: opts.domain ?? null,
    },
    opts.tenantId,
  );
  if (!result.ok || !('data' in result)) return result as BrainWriteResult;
  return {
    ok: true,
    nodeId: typeof result.data.node_id === 'string' ? result.data.node_id : undefined,
    duplicate: result.data.duplicate === true,
  };
}

/** Link two memory nodes with a directed, weighted relation (POST
 *  /brain/edges) — e.g. "this carrier's exception refines this failure
 *  pattern," "this tool cites this portal version." Both endpoints must
 *  already be visible to this tenant (own rows or global rows) — the server
 *  422s a cross-tenant link attempt (BrainVisibilityError), surfaced here as
 *  reason:'invalid'. `weight` defaults to 1.0 (full confidence), matching the
 *  server default. */
export async function link(opts: {
  fromId: string;
  toId: string;
  relation: string;
  weight?: number;
  tenantId?: string;
}): Promise<BrainWriteResult> {
  const result = await postBrain(
    '/brain/edges',
    {
      from_id: opts.fromId,
      to_id: opts.toId,
      relation: opts.relation,
      weight: opts.weight ?? 1.0,
    },
    opts.tenantId,
  );
  if (!result.ok || !('data' in result)) return result as BrainWriteResult;
  return {
    ok: true,
    edgeId: typeof result.data.edge_id === 'string' ? result.data.edge_id : undefined,
  };
}
