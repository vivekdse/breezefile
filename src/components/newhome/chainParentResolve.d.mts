// Types for chainParentResolve.mjs (runtime is plain ESM; this types it for TS
// consumers — the RosterTable watcher). See the .mjs for the contract.

import type { TaskDef } from './types';

export function isTerminalRaw(raw: string | null | undefined): boolean;

export function buildChainAggregateResult(chain: {
  defs: TaskDef[];
  valuesByRef: Record<string, string | number>;
}): { type: 'fields'; fields: Record<string, string | number> };

export function parentStatusFromChildren(
  childStates: { rawStatus?: string | null }[],
): { status: 'done' | 'partial' } | null;

export function shouldResolveParent(
  parentRawStatus: string | null | undefined,
  resolution: { status: 'done' | 'partial' } | null,
): boolean;
