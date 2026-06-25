// task-897a13d67632 — PURE effective-DESCRIPTION + effective-INSTRUCTION
// resolvers with SCOPES and PROVENANCE. Authored as plain ESM (co-located
// resolver.d.mts for the TS app) so `node --test tests/` imports it directly.
// No React, no IPC, no DOM.
//
// ── The two cascades ────────────────────────────────────────────────────────
// 1. DESCRIPTION cascade (dual-purpose: human label + agent context). A sub-
//    project's effective description = ancestor descriptions + own, general→
//    specific. We CONCATENATE (descriptions accumulate context; they don't
//    override) so an agent reading a leaf project sees the whole lineage.
//
// 2. INSTRUCTION cascade (rules an agent must follow). A task inherits the
//    UNION of every scope it belongs to, resolved most-GENERAL → most-SPECIFIC
//    with more-specific OVERRIDING. Scope order (general→specific):
//        Organization → Project → Category cohorts → Parent task → Task
//    Each resolved rule carries PROVENANCE (which scope it came from) so the UI
//    can render "8 — 4 project · 2 HMO · 1 prior-auth · 1 task".
//
// ── Reuse the server's project leg ──────────────────────────────────────────
// The TypeBuild server already computes the PROJECT-ONLY cascade as
// Project.effectiveInstructions (organization + project ancestry, general→
// specific, folded into one block). We REUSE that value for the project leg
// rather than re-deriving it from each ancestor's `instructions`, then layer
// the category / parent-task / task scopes ON TOP. This keeps the client in
// lockstep with server semantics for the project portion and only adds the
// scopes the server doesn't know about.
//
// ── Category / tag-cohort scopes (CLIENT-SIDE ASSUMPTION) ───────────────────
// The remote Task shape carries no tag/category field today (see ../types
// Task — there is no `tags`). So category scopes are modeled CLIENT-SIDE from
// whatever cohort signal the caller supplies: the resolver takes the task's
// category keys (e.g. ['payer:HMO','kind:prior-auth']) and a lookup of
// category-key → instruction rules. WHERE those keys + rules come from is the
// caller's concern (task tags once the server grows them, or a local cohort
// store meanwhile). This module just resolves them in the right order with the
// right provenance. ASSUMPTION recorded here; no server change is blocked on.
//
// NON-PHI throughout: descriptions/instructions/category-keys are teaching
// context, never patient data. Rule TEXT is treated as opaque; we never parse
// it for meaning.

/** @typedef {import('../types').Project} Project */
/** @typedef {import('./resolver.d.mts').ScopeKind} ScopeKind */
/** @typedef {import('./resolver.d.mts').ResolvedRule} ResolvedRule */
/** @typedef {import('./resolver.d.mts').InstructionScope} InstructionScope */
/** @typedef {import('./resolver.d.mts').ResolvedInstructions} ResolvedInstructions */

// Most-general → most-specific. Lower rank = more general. A more-specific
// rule with the same key OVERRIDES a more-general one.
export const SCOPE_ORDER = /** @type {ScopeKind[]} */ ([
  'organization',
  'project',
  'category',
  'parent-task',
  'task',
]);

const SCOPE_RANK = new Map(SCOPE_ORDER.map((k, i) => [k, i]));

// ─── DESCRIPTION resolver ───────────────────────────────────────────────────

/**
 * Effective description for a project: ancestor descriptions + own, general→
 * specific, each segment tagged with its source project so the UI can show the
 * inherited-vs-own split (the mockup renders inherited segments dimmed).
 *
 * @param {Project[]} ancestorChain general→specific, ending with the target
 *   project (exactly what tree.ancestorChain returns).
 * @returns {import('./resolver.d.mts').ResolvedDescription}
 */
export function resolveEffectiveDescription(ancestorChain) {
  const chain = Array.isArray(ancestorChain) ? ancestorChain : [];
  /** @type {import('./resolver.d.mts').DescriptionSegment[]} */
  const segments = [];
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const text = (p.description ?? '').trim();
    if (!text) continue;
    segments.push({
      projectId: p.id,
      projectName: p.name,
      text,
      own: i === chain.length - 1,
    });
  }
  return {
    segments,
    // The whole lineage as one agent-ready block, general→specific.
    text: segments.map((s) => s.text).join('\n\n'),
  };
}

// ─── INSTRUCTION resolver ───────────────────────────────────────────────────

// A rule is a single instruction line. We treat each non-empty line of a
// scope's instruction block as one rule, KEYED for override by its normalized
// text (trimmed, lowercased, trailing punctuation stripped). Two scopes with
// the "same" rule (e.g. project says "Always attach the referral", task repeats
// it) collapse to ONE resolved rule attributed to the MORE-SPECIFIC scope — so
// the provenance counts reflect where each surviving rule actually lands.
//
// This line-as-rule model is deliberately simple: the server stores free-text
// instruction blocks, not structured rules, so there's no richer key to use.
// Callers that DO have structured rules can pass them via `rules` on a scope
// (see resolveEffectiveInstructions) and skip the line-splitting.

function normalizeKey(text) {
  return text.trim().toLowerCase().replace(/[.;:,\s]+$/, '');
}

/** Split a free-text instruction block into individual rule lines. Bullets
 *  ('- ', '* ', '• ', '1. ') are stripped so the same rule keyed from a bullet
 *  list and a plain line collapse together. */
function splitRules(block) {
  if (!block || typeof block !== 'string') return [];
  return block
    .split('\n')
    .map((ln) => ln.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((ln) => ln.length > 0);
}

/**
 * Resolve the effective instruction-set for a task as the UNION of every scope
 * it belongs to, general→specific, with more-specific rules OVERRIDING (by
 * normalized text). Returns the surviving rules WITH provenance plus per-scope
 * counts for the "8 — 4 project · 2 HMO · 1 prior-auth · 1 task" summary.
 *
 * @param {import('./resolver.d.mts').InstructionInput} input
 * @returns {ResolvedInstructions}
 */
export function resolveEffectiveInstructions(input) {
  const scopes = normalizeScopes(input);

  // Sort scopes general→specific. Stable within a rank so multiple category
  // cohorts keep their supplied order (the UI lists them in that order).
  const ordered = scopes
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = SCOPE_RANK.get(a.s.kind) ?? 99;
      const rb = SCOPE_RANK.get(b.s.kind) ?? 99;
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .map((x) => x.s);

  // Walk general→specific; later (more-specific) writes win for a given key.
  /** @type {Map<string, ResolvedRule>} */
  const byKey = new Map();
  for (const scope of ordered) {
    const rules = scopeRules(scope);
    for (const text of rules) {
      const key = normalizeKey(text);
      if (!key) continue;
      byKey.set(key, {
        text,
        key,
        scopeKind: scope.kind,
        scopeId: scope.id,
        scopeLabel: scope.label,
      });
    }
  }

  const rules = [...byKey.values()];

  // Per-scope-instance counts (keyed by scopeId so two category cohorts report
  // separately) AND per-scope-kind totals (for the coarse summary).
  /** @type {InstructionScope[]} */
  const scopeSummaries = [];
  /** @type {Record<string, number>} */
  const byKind = { organization: 0, project: 0, category: 0, 'parent-task': 0, task: 0 };
  // Preserve scope identity + order for the UI even when a scope contributed 0
  // surviving rules (it may have been fully overridden).
  const countById = new Map();
  for (const r of rules) {
    countById.set(r.scopeId, (countById.get(r.scopeId) ?? 0) + 1);
    byKind[r.scopeKind] = (byKind[r.scopeKind] ?? 0) + 1;
  }
  for (const scope of ordered) {
    scopeSummaries.push({
      kind: scope.kind,
      id: scope.id,
      label: scope.label,
      count: countById.get(scope.id) ?? 0,
    });
  }

  return {
    rules,
    total: rules.length,
    scopes: scopeSummaries,
    byKind,
    summary: formatSummary(rules.length, scopeSummaries),
  };
}

/**
 * One-line provenance summary, e.g. "8 — 4 project · 2 payer:HMO · 1 task".
 * Scopes contributing 0 surviving rules are omitted. Uses each scope's label.
 * @param {number} total
 * @param {InstructionScope[]} scopes
 * @returns {string}
 */
export function formatSummary(total, scopes) {
  const parts = scopes
    .filter((s) => s.count > 0)
    .map((s) => `${s.count} ${s.label}`);
  return parts.length ? `${total} — ${parts.join(' · ')}` : `${total}`;
}

// ─── input normalization ────────────────────────────────────────────────────
// The caller assembles scopes from heterogeneous sources; we normalize them
// into a uniform { kind, id, label, rules | block } shape and DROP empties.

function normalizeScopes(input) {
  const out = [];
  const i = input || {};

  // Organization: an explicit free-text block (rarely set; server may fold it
  // into effectiveInstructions already — pass it only if you have a distinct
  // org block to layer).
  if (i.organization && firstNonEmpty(i.organization.instructions, i.organization.rules)) {
    out.push({
      kind: 'organization',
      id: i.organization.id ?? 'org',
      label: i.organization.label ?? 'organization',
      block: i.organization.instructions,
      rules: i.organization.rules,
    });
  }

  // Project leg: REUSE the server's Project.effectiveInstructions when given
  // (it already folds org+project ancestry). Fall back to the project's own
  // `instructions` if effectiveInstructions is absent.
  if (i.project) {
    const block = i.project.effectiveInstructions ?? i.project.instructions ?? '';
    if (firstNonEmpty(block, i.project.rules)) {
      out.push({
        kind: 'project',
        id: i.project.id ?? 'project',
        label: i.project.label ?? 'project',
        block,
        rules: i.project.rules,
      });
    }
  }

  // Category cohorts (client-side; see header). Each cohort is its own scope
  // instance so the UI can attribute "2 payer:HMO · 1 kind:prior-auth".
  for (const cat of i.categories || []) {
    if (!cat) continue;
    if (firstNonEmpty(cat.instructions, cat.rules)) {
      out.push({
        kind: 'category',
        id: cat.id ?? cat.key ?? cat.label ?? 'category',
        label: cat.label ?? cat.key ?? cat.id ?? 'category',
        block: cat.instructions,
        rules: cat.rules,
      });
    }
  }

  // Parent task scope.
  if (i.parentTask && firstNonEmpty(i.parentTask.instructions, i.parentTask.rules)) {
    out.push({
      kind: 'parent-task',
      id: i.parentTask.id ?? 'parent-task',
      label: i.parentTask.label ?? 'parent task',
      block: i.parentTask.instructions,
      rules: i.parentTask.rules,
    });
  }

  // Task scope (most specific).
  if (i.task && firstNonEmpty(i.task.instructions, i.task.rules)) {
    out.push({
      kind: 'task',
      id: i.task.id ?? 'task',
      label: i.task.label ?? 'task',
      block: i.task.instructions,
      rules: i.task.rules,
    });
  }

  return out;
}

/** A scope's rule TEXTS: explicit `rules` array wins; else split the block. */
function scopeRules(scope) {
  if (Array.isArray(scope.rules) && scope.rules.length) {
    return scope.rules.map((r) => (typeof r === 'string' ? r : String(r))).filter(Boolean);
  }
  return splitRules(scope.block);
}

function firstNonEmpty(block, rules) {
  if (Array.isArray(rules) && rules.some((r) => r && String(r).trim())) return true;
  return typeof block === 'string' && block.trim().length > 0;
}
