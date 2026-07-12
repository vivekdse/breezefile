// task-64815d2ed7b9 — type surface for the pure queryPlan.mjs executor
// (runtime is plain ESM so the node test runner imports it without a transpile
// step). Mirrors the queryEngine.d.mts convention.

export type Rec = Record<string, unknown>;

export type QueryPlanOp = '=' | '==' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | '~' | 'contains' | 'exists';
export type QueryPlanAggKind = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'collect';
export type QueryPlanSource = 'tasks' | 'projects';
export type QueryPlanJoin = 'project' | 'parent';

export type QueryPlanClause = { field: string; op: QueryPlanOp; value?: unknown };

export type QueryPlan = {
  source: QueryPlanSource;
  join?: QueryPlanJoin | null;
  where?: QueryPlanClause[];
  groupBy?: string | string[];
  aggregate?: { kind: QueryPlanAggKind; field?: string; as?: string };
  sort?: { by: string; desc?: boolean };
  limit?: number;
};

export type QueryPlanResult =
  | {
      ok: true;
      shape: 'groups';
      rows: Rec[];
      groupBy: string | string[];
      aggregate: { kind: QueryPlanAggKind; field?: string; as: string };
      total: number;
    }
  | {
      ok: true;
      shape: 'scalar';
      value: unknown;
      aggregate: { kind: QueryPlanAggKind; field?: string };
      total: number;
    }
  | { ok: true; shape: 'rows'; rows: Rec[]; total: number }
  | { ok: false; error: string };

export function validatePlan(plan: unknown): string | null;
export function runQueryPlan(
  plan: unknown,
  data: { tasks?: Rec[]; projects?: Rec[] },
): QueryPlanResult;
export function formatPlanResult(result: QueryPlanResult, max?: number): string;

export const QUERY_PLAN_FIELDS: {
  tasks: string[];
  taskJoinProject: string[];
  taskJoinParent: string[];
  projects: string[];
  ops: string[];
  aggregateKinds: string[];
  joins: string[];
  sources: string[];
};
