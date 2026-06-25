// task-897a13d67632 — type surface for the pure resolver.mjs module (runtime is
// plain ESM so the node test runner imports it without a transpile step).
import type { Project } from '../types';

// ─── DESCRIPTION ─────────────────────────────────────────────────────────────

/** One project's contribution to the effective description. */
export interface DescriptionSegment {
  projectId: string;
  projectName: string;
  text: string;
  /** True for the target project's own description; false for inherited. */
  own: boolean;
}

export interface ResolvedDescription {
  /** Ancestor→own segments, general→specific. */
  segments: DescriptionSegment[];
  /** The whole lineage joined into one agent-ready block. */
  text: string;
}

/**
 * Effective description for a project: ancestor descriptions + own,
 * general→specific. Pass the chain from tree.ancestorChain (ends with target).
 */
export function resolveEffectiveDescription(ancestorChain: Project[]): ResolvedDescription;

// ─── INSTRUCTIONS ────────────────────────────────────────────────────────────

/** The scopes a task can inherit from, most-general → most-specific. */
export type ScopeKind =
  | 'organization'
  | 'project'
  | 'category'
  | 'parent-task'
  | 'task';

/** Scope order, general→specific (index = override rank). */
export const SCOPE_ORDER: ScopeKind[];

/** One surviving instruction rule, with provenance. */
export interface ResolvedRule {
  /** The rule text as authored (in the winning scope). */
  text: string;
  /** Normalized override key (trimmed/lowercased/de-punctuated). */
  key: string;
  /** Which scope KIND this rule came from. */
  scopeKind: ScopeKind;
  /** The specific scope instance id (a category cohort key, project id, etc.). */
  scopeId: string;
  /** Human label for the scope instance (e.g. 'payer:HMO', 'project'). */
  scopeLabel: string;
}

/** Per-scope-instance count of surviving rules (for the provenance summary). */
export interface InstructionScope {
  kind: ScopeKind;
  id: string;
  label: string;
  /** How many surviving rules this scope contributed (post-override). */
  count: number;
}

export interface ResolvedInstructions {
  /** Surviving rules, de-duplicated by key (more-specific wins). */
  rules: ResolvedRule[];
  /** rules.length. */
  total: number;
  /** Per-scope-instance summaries in general→specific order. */
  scopes: InstructionScope[];
  /** Per-scope-KIND totals. */
  byKind: Record<ScopeKind, number>;
  /** "8 — 4 project · 2 payer:HMO · 1 task" (omits 0-count scopes). */
  summary: string;
}

// ── input shapes ──
// A scope source provides EITHER a free-text `instructions` block (split into
// line-rules) OR an explicit `rules` array (used verbatim). `rules` wins.

export interface ScopeSource {
  id?: string;
  label?: string;
  instructions?: string | null;
  rules?: string[];
}

/** Project leg input — pass the bridge Project so its `effectiveInstructions`
 *  (server-computed org+project cascade) is reused. */
export interface ProjectScopeSource extends ScopeSource {
  effectiveInstructions?: string;
  instructions?: string | null;
}

/** A client-side category/tag-cohort scope, e.g. { key:'payer:HMO', ... }. */
export interface CategoryScopeSource extends ScopeSource {
  key?: string;
}

export interface InstructionInput {
  organization?: ScopeSource;
  /** Pass the bridge Project (effectiveInstructions reused for the project leg). */
  project?: {
    id?: string;
    instructions?: string | null;
    effectiveInstructions?: string;
    label?: string;
    rules?: string[];
  };
  /** Client-side cohort scopes (see resolver.mjs header for the assumption). */
  categories?: CategoryScopeSource[];
  parentTask?: ScopeSource;
  task?: ScopeSource;
}

/** Resolve a task's effective instruction-set (union across scopes, more-
 *  specific overriding) with provenance. */
export function resolveEffectiveInstructions(input: InstructionInput): ResolvedInstructions;

/** One-line provenance summary from a total + per-scope counts. */
export function formatSummary(total: number, scopes: InstructionScope[]): string;
