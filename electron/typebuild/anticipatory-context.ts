// Anticipatory planner (task-8f71349656db "Brain C2", epic task-8913f9bc2230
// federated multi-tenant agentic memory).
//
// GOAL: the moment a task lands in the queue, extract its NON-PHI facets
// (task type, target platform/URL, entities) and call the brain's
// assemble_context (POST /brain/context — brain-client.ts's assembleContext)
// so the run starts ALREADY ORIENTED with relevant historical memory + mapped
// target domains, instead of discovering as it goes. This is the SAME goal as
// task-context-bundle.ts's existing GET /chromeext/<id>/context-bundle path —
// this module is a SIBLING leg that adds the brain's layered, cross-tenant
// memory (global tools, org rules, task notes) and the Brain #7
// task→site-resolution fold (`candidate_sites`), NOT a replacement. Both
// addenda are injected together (see typebuild.ts wave1 dispatch).
//
// FACET EXTRACTION — NON-PHI ONLY (load-bearing, mirrors site-memory.ts /
// task-data.ts's PHI discipline):
//   - taskType : the task's TEMPLATE id (`SourcedTask.templateId`) when
//     present. This is an opaque, non-PHI classification handle — NOT the
//     task title, which is PHI and must never reach the brain. Templates are
//     the closest thing this client has today to a task-type taxonomy; when
//     absent we simply omit task_type (assemble_context degrades gracefully —
//     see read_api.py: every facet is optional).
//   - url / domain : the task's `start_url` when the detail is already known
//     (routing metadata, not PHI — pii-data-injection-design.md classifies a
//     portal URL as a REFERENCE, same class as `payer.portal_url` in
//     docs/operator-speed/task-intake-architecture.md). When neither is known
//     yet we omit both and let the server's Brain #7 candidate-site inference
//     do the work (`candidate_sites` on the response).
//   - entities : left empty for now — today's task shape carries no non-PHI
//     entity/code labels (the intake schema in task-intake-architecture.md
//     that would populate this is still "Proposed", not implemented). Wired
//     as an explicit, optional facet so a future intake-schema consumer only
//     has to populate the array, not touch this module's plumbing.
//   - taskId : the opaque task id, scoping the `task_notes` tier to this run.
//
// NEVER SENT: task title/body (PHI), any `data` bag value, any entity-vault
// value. Only opaque ids / classification labels / URLs cross the wire.
//
// FAILURE MODE: assembleContext (brain-client.ts) already degrades to an
// empty, zero-row bundle on ANY failure (network, auth, brain down) — never
// throws. This module inherits that: a brain outage renders '' and the
// launch proceeds exactly as it does today without this feature.

import {
  assembleContext,
  tierLabel,
  type BrainContextBundle,
  type BrainMemoryRow,
} from './brain-client';

/** The NON-PHI facets this planner extracts from a just-landed task. Every
 *  field here must be a reference/classification label, NEVER the task
 *  title/body or a PHI `data` value — see the header. */
export interface TaskFacets {
  taskId: string;
  /** Opaque template id (proxy for "task type") — NOT the task title. */
  taskType?: string | null;
  /** Start URL, when already known (routing metadata, NON-PHI). */
  url?: string | null;
  /** Registrable domain, when already known and the URL isn't. */
  domain?: string | null;
  /** NON-PHI entity labels (e.g. payer names, CPT/ICD codes) — empty until an
   *  intake schema populates them (see header). */
  entities?: string[];
}

function summarizeRows(rows: BrainMemoryRow[], limit: number): string[] {
  return rows
    .slice(0, limit)
    .map((r) => (r.summary && r.summary.trim()) || r.content.trim())
    .filter(Boolean);
}

/** Render the brain's layered bundle as Markdown for the launch addendum.
 *  Returns '' when the bundle is entirely empty (no rows, no candidate
 *  sites) so the caller can spread it conditionally, mirroring
 *  renderBundleAddendum in task-context-bundle.ts. Caps each tier's rows so
 *  the addendum stays a bounded, skimmable brief rather than a raw dump —
 *  the server already token-budgeted the bundle, this is a display trim on
 *  top of that. */
export function renderAnticipatoryAddendum(bundle: BrainContextBundle): string {
  const sections: string[] = [];

  const tiers: Array<[string, BrainMemoryRow[]]> = [
    [`Tools (${tierLabel('global')})`, bundle.globalTools.rows],
    [`Site memory (${tierLabel('global')})`, bundle.siteMemory.rows],
    [`Org rules (${tierLabel('org')})`, bundle.tenantRules.rows],
    [`This task (${tierLabel('task')})`, bundle.taskNotes.rows],
  ];
  for (const [label, rows] of tiers) {
    const lines = summarizeRows(rows, 8);
    if (lines.length === 0) continue;
    sections.push(`${label}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }

  if (bundle.candidateSites.length > 0) {
    sections.push(
      `Candidate site(s) for this task (task→site resolution — no domain/url was ` +
        `given, so these are inferred, most-relevant first; confirm before acting ` +
        `on an ambiguous match):\n${bundle.candidateSites.map((s) => `- ${s}`).join('\n')}`,
    );
  }

  if (sections.length === 0) return '';

  return [
    '# Brain memory (anticipatory planner — treat as already-recalled)',
    '',
    'The following NON-PHI context was assembled up front from the federated',
    'memory brain (global tools, org rules, prior notes on this task, and',
    'candidate target sites). Use it directly and do NOT re-run the ',
    'equivalent recall for this same context before acting; use `recall` ',
    'mid-run only for what this launch bundle did not cover.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/** Fetch the brain's anticipatory context bundle for a just-landed task and
 *  render it as a system-prompt addendum in one call. Never throws — a brain
 *  outage or empty bundle degrades to ''. `targetTokens` mirrors
 *  assembleContext's budget knob (default 4096, same as the server default). */
export async function fetchAnticipatoryAddendum(
  facets: TaskFacets,
  opts: { targetTokens?: number } = {},
): Promise<{ addendum: string; bundle: BrainContextBundle }> {
  const bundle = await assembleContext({
    taskType: facets.taskType ?? undefined,
    url: facets.url ?? undefined,
    domain: facets.url ? undefined : facets.domain ?? undefined,
    entities: facets.entities,
    taskId: facets.taskId,
    targetTokens: opts.targetTokens,
  });
  return { addendum: renderAnticipatoryAddendum(bundle), bundle };
}
