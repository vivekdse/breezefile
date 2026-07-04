// Chain-parent resolution (client-side interim) — PURE helpers.
//
// Today "Done · Chain complete" is CLIENT-DISPLAY ONLY: metaStatus mirrors the
// children in the UI, but nothing resolves the PARENT container server-side.
// If the server does NOT flip the parent itself, that parent stays open/
// unclaimed forever — claim_next can hand out a completed empty container,
// project rollups break, and the roster's raw status still reads "Queued".
//
// This module owns the three PURE, testable pieces of the client-side interim
// fix; the (impure) watcher in RosterTable wires them to the source layer:
//   - buildChainAggregateResult: merge every non-skipped child's outputs into
//     ONE flat {type:'fields'} result the parent carries as its chain evidence.
//   - parentStatusFromChildren: map the set of terminal child states to the
//     parent's resolution ('done' | 'partial' | null-when-not-yet-terminal).
//   - shouldResolveParent: the IDEMPOTENCY guard — resolve the parent EXACTLY
//     ONCE, and never fight a server that already flipped it terminal itself.
//
// PHI (docs/typebuild-data-field-contract.md): child output VALUES are
// potentially PHI. buildChainAggregateResult shapes them in memory only for the
// submit payload; it NEVER logs or persists them, and neither must its callers.

import { fieldRef, taskDefStatus } from './taskSchema.mjs';

/** "Settled" server rawStatuses for chain-resolution purposes: a child in one
 *  of these will NOT advance the chain on its own. `blocked` is included — a
 *  blocked child is stuck, not transient, so the chain can't complete and the
 *  parent should resolve partial rather than hang forever waiting on it.
 *  (electron/sources/typebuild.ts rawStatus vocabulary.) */
const TERMINAL_RAW = new Set(['done', 'partial', 'cancelled', 'failed', 'blocked']);

/** A child rawStatus that means "this step succeeded". */
const OK_RAW = new Set(['done']);

/** A child rawStatus that means "this step ended WITHOUT success" (and is not a
 *  deliberate skip/n-a — those never appear as a real child row at all). */
const BAD_RAW = new Set(['partial', 'cancelled', 'failed', 'blocked']);

export function isTerminalRaw(raw) {
  return typeof raw === 'string' && TERMINAL_RAW.has(raw);
}

/**
 * Merge every non-skipped child's OUTPUT values into one flat, ref-keyed result
 * the parent carries as its chain's evidence when it's submitted done. Keys are
 * `fieldRef(defId, key)` (e.g. `intake.ok`, `deliver.delivered_at`) so the
 * aggregate is unambiguous across steps that share an output key name.
 *
 * A "skip" step (its def's neededWhen is unmet) contributes nothing — the chain
 * legitimately routed around it. Input values are NOT included; only OUTPUTS
 * are the chain's produced evidence.
 *
 * @param {{ defs: import('./types').TaskDef[], valuesByRef: Record<string, string|number> }} chain
 * @returns {{ type: 'fields', fields: Record<string, string|number> }}
 */
export function buildChainAggregateResult(chain) {
  const defs = chain?.defs ?? [];
  const valuesByRef = chain?.valuesByRef ?? {};
  /** @type {Record<string, string|number>} */
  const fields = {};
  for (const def of defs) {
    // Skip a conditionally-gated (n/a) def — it produced nothing on purpose.
    if (taskDefStatus(def, valuesByRef) === 'skip') continue;
    for (const out of def.outputs ?? []) {
      const ref = fieldRef(def.id, out.key);
      const v = valuesByRef[ref];
      if (v !== undefined && v !== null && v !== '') fields[ref] = v;
    }
  }
  return { type: 'fields', fields };
}

/**
 * Map the LAST-non-skipped-child terminal states to the parent's resolution.
 *
 * Rules (per the task):
 *   - every relevant child terminal AND all 'done'    → { status: 'done' }
 *   - any relevant child cancelled/blocked/failed/partial (not a skip)
 *                                                      → { status: 'partial' }
 *   - not every relevant child is terminal yet         → null (do nothing;
 *                                                        the chain is still live)
 *
 * "Relevant" = a real child row that is not a skip/n-a. A step with no child
 * row yet (unstarted) makes the chain NOT-yet-terminal → null.
 *
 * @param {{ rawStatus?: string | null }[]} childStates  one entry PER non-skipped
 *        step that HAS a child (in step order); a step still missing its child
 *        should be represented as `{ rawStatus: null }` so we return null.
 * @returns {{ status: 'done' | 'partial' } | null}
 */
export function parentStatusFromChildren(childStates) {
  const states = childStates ?? [];
  if (states.length === 0) return null; // nothing to resolve on
  // Any not-yet-terminal child → the chain is still running; don't resolve.
  if (states.some((c) => !isTerminalRaw(c?.rawStatus ?? null))) return null;
  // All terminal. If every one is a success → done; otherwise partial.
  const allOk = states.every((c) => OK_RAW.has(c?.rawStatus ?? ''));
  if (allOk) return { status: 'done' };
  // At least one bad terminal state (cancelled/blocked/failed/partial).
  if (states.some((c) => BAD_RAW.has(c?.rawStatus ?? ''))) return { status: 'partial' };
  // Defensive: all terminal but none matched ok/bad (shouldn't happen given the
  // vocabulary) — treat as partial rather than falsely claiming done.
  return { status: 'partial' };
}

/**
 * IDEMPOTENCY + safety guard. Decide whether the client should submit the
 * parent's resolution at all.
 *
 * Returns false (do NOTHING) when:
 *   - there is no resolution yet (children not all terminal), OR
 *   - the parent is ALREADY terminal server-side. This covers BOTH
 *       (a) we already submitted it once this session, and
 *       (b) the SERVER resolved the parent on its own (the safety case: never
 *           double-submit / fight the server — just reflect the real status).
 *
 * Returns true only when there IS a resolution AND the parent is still
 * non-terminal (open/queued/in_progress) — the one moment a client submit is
 * both needed and legal.
 *
 * @param {string | null | undefined} parentRawStatus  the parent's CURRENT server rawStatus
 * @param {{ status: 'done' | 'partial' } | null} resolution  from parentStatusFromChildren
 * @returns {boolean}
 */
export function shouldResolveParent(parentRawStatus, resolution) {
  if (!resolution) return false;
  if (isTerminalRaw(parentRawStatus ?? null)) return false;
  return true;
}
