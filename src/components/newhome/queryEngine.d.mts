// task-749ecd0c34a4 — type surface for the pure queryEngine.mjs module
// (runtime is plain ESM so the node test runner imports it without a
// transpile step). Mirrors the rosterGroups.d.mts / taskSchema.d.mts
// convention.

export type Rec = Record<string, unknown>;

// source
export function from(records: Rec[] | null | undefined): Rec[];

// derived fields
export function deriveProjectRepo(
  project: { folders?: string[] | null } | null | undefined,
): { repo: string | null; repoDir: string | null };
export function withProjectDerived(project: Rec): Rec;
export function withDerivedProjects(projects: Rec[]): Rec[];

// where / filter
export function where(records: Rec[], predicate: (rec: Rec) => boolean): Rec[];
export function filter(records: Rec[], predicate: (rec: Rec) => boolean): Rec[];
export function whereEq(records: Rec[], field: string, value: unknown): Rec[];
export function whereIn(records: Rec[], field: string, values: unknown[]): Rec[];

// select / project
export function select(records: Rec[], shape: string[] | ((rec: Rec) => Rec)): Rec[];

// sort / limit
export function sort(
  records: Rec[],
  by: string | ((a: Rec, b: Rec) => number),
  opts?: { desc?: boolean },
): Rec[];
export function limit(records: Rec[], n: number): Rec[];

// group-by
export type Group = { key: unknown; items: Rec[] };
export function groupBy(records: Rec[], by: string | ((rec: Rec) => unknown)): Group[];

// aggregate
export type AggregateKind = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'collect';
export function aggregate(items: Rec[], kind: AggregateKind, field?: string): number | unknown[] | null;
export function groupAggregate(
  records: Rec[],
  by: string | ((rec: Rec) => unknown),
  kind: AggregateKind,
  field?: string,
  as?: string,
): Rec[];

// lookup / join
export function indexBy(records: Rec[], by: string | ((rec: Rec) => unknown)): Map<unknown, Rec>;
export function joinTaskProject(
  tasks: Rec[],
  projects: Rec[],
  opts?: { taskKey?: string; projectKey?: string; as?: string },
): Rec[];
export function joinTaskParent(
  tasks: Rec[],
  allTasks: Rec[],
  opts?: { parentKey?: string; idKey?: string; as?: string },
): Rec[];
export function taskParentChain(
  task: Rec,
  allTasks: Rec[],
  opts?: { parentKey?: string; idKey?: string },
): Rec[];
