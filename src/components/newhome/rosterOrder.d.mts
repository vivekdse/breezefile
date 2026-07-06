// Type surface for the pure rosterOrder.mjs module (runtime is plain ESM so
// `node --test` imports it without a transpile step). Mirrors the
// rosterGroups.d.mts convention.

export type RosterRow = {
  id: string;
  status: string;
  lastActionAt?: number | null;
  priority?: number;
  raw?: { priority?: number } & Record<string, unknown>;
};

export function recencyOf(row: RosterRow): number;

export function sortByRecency<T extends RosterRow>(rows: T[]): T[];

export function partitionByRecency<T extends RosterRow>(
  rows: T[],
  opts: { now: number; hotDays: number },
): { hot: T[]; cold: T[] };

export function paginateGroupAware<T extends RosterRow>(
  rows: T[],
  groupKeyOf: (row: T) => string | null,
  opts: { limit: number },
): { page: T[]; shown: number; total: number; hasMore: boolean };
