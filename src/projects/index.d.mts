// task-897a13d67632 — type surface for the projects barrel.
export type { ProjectNode, TaskStats } from './tree.d.mts';
export {
  buildProjectTree,
  indexTree,
  ancestorChain,
  breadcrumbPath,
  rollUpTaskStats,
} from './tree.d.mts';
export type {
  ScopeKind,
  ResolvedRule,
  InstructionScope,
  ResolvedInstructions,
  ResolvedDescription,
  DescriptionSegment,
  ScopeSource,
  CategoryScopeSource,
  InstructionInput,
} from './resolver.d.mts';
export {
  SCOPE_ORDER,
  resolveEffectiveDescription,
  resolveEffectiveInstructions,
  formatSummary,
} from './resolver.d.mts';
