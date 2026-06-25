// task-897a13d67632 — type surface for the pure tree.mjs module (runtime is
// plain ESM so the node test runner imports it without a transpile step).
import type { Project, Task } from '../types';

/** A node in the project forest. `children` is sorted by name. */
export interface ProjectNode {
  project: Project;
  children: ProjectNode[];
  /** 0 for roots; +1 per level. */
  depth: number;
  /** Effective parent id (null for roots/orphans/cycle-broken nodes). */
  parentId: string | null;
}

/** Per-status task tallies. `needsYou` = open/blocked work wanting a human. */
export interface TaskStats {
  total: number;
  open: number;
  inProgress: number;
  done: number;
  cancelled: number;
  blocked: number;
  needsYou: number;
}

/** Build a parent→child forest from a flat Project list (arbitrary depth). */
export function buildProjectTree(projects: Project[]): ProjectNode[];

/** Flatten a forest into a Map<id, ProjectNode> for O(1) lookup. */
export function indexTree(treeOrRoots: ProjectNode[] | ProjectNode): Map<string, ProjectNode>;

/** Root→target project chain, general→specific (ends with the target). */
export function ancestorChain(roots: ProjectNode[], projectId: string): Project[];

/** Human breadcrumb path, e.g. "Insurance Authorization › Aetna HMO". */
export function breadcrumbPath(roots: ProjectNode[], projectId: string, sep?: string): string;

/** Per-project own + rolled-up (own + descendants) task stats. */
export function rollUpTaskStats(
  roots: ProjectNode[],
  tasks: Task[],
): Map<string, { own: TaskStats; rolled: TaskStats }>;
