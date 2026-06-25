// task-897a13d67632 — barrel for the pure project model + resolvers. UI
// children import from here:
//   import { buildProjectTree, breadcrumbPath, rollUpTaskStats,
//            ancestorChain, resolveEffectiveDescription,
//            resolveEffectiveInstructions } from '../projects/index.mjs';
export {
  buildProjectTree,
  indexTree,
  ancestorChain,
  breadcrumbPath,
  rollUpTaskStats,
} from './tree.mjs';
export {
  SCOPE_ORDER,
  resolveEffectiveDescription,
  resolveEffectiveInstructions,
  formatSummary,
} from './resolver.mjs';
