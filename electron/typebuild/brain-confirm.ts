// Confirm/reject for CANDIDATE-tier brain knowledge (task-35dde066caf7 "Brain
// C5"; folds superseded Brain #9, task-13ac13209917).
//
// IMPORTANT — what "confirm" can and cannot do, verified against brain_api's
// api.py at the time of writing: there is NO HTTP confirm/reject/promote
// endpoint. candidate -> active promotion is done EXCLUSIVELY by the curator
// (S6's async sweep loop, curator_worker.py, ~120s interval) — see
// brain-client.ts's header comment for the same finding. So this module does
// NOT (and cannot) force a server-side promotion. What it DOES do:
//
//   1. autoConfirmCandidate(row) — the DEFAULT path for agent-driven flows.
//      Since record_observation/propose_tool already land a row as a
//      'candidate' the moment they're written (no client action gates that),
//      "auto-confirm" here means: don't show the human anything, don't block,
//      just let the curator do its job async. This function exists so call
//      sites have an explicit, named no-op to call instead of silently doing
//      nothing — it's the auto-confirm decision made LEGIBLE in the code (and
//      the seam a future promote-endpoint would slot into).
//
//   2. rejectCandidateLocally(row) — when a human (or agent) decides a
//      candidate is WRONG, we cannot un-write it server-side from here either
//      (no reject endpoint). What we CAN do: never mirror it into the local
//      ACTIVE-only cache (site-memory.ts already only mirrors active rows —
//      see acceptActiveNotes there) and remember the rejection locally so the
//      SAME candidate doesn't re-surface a confirm prompt every run. This is a
//      client-side suppression list, not a server mutation.
//
// HUMAN-FACING PROMPT CONVENTION: matched to this repo's existing pattern for
// "agent proposes, human approves/rejects" — src/copilot/actionKit.tsx's
// confirmedAction/ConfirmCard (a small approve/reject card reusing
// ConfirmDialog's visual language), NOT a blocking native dialog. The React
// side (src/components/CandidateKnowledgeCard.tsx) follows that same
// look-and-feel. This module is the electron/main-side bookkeeping the card
// calls into; it holds no UI.
//
// NON-PHI: candidate rows are brain memory/tool content — never a task body.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import type { BrainMemoryRow } from './brain-client';

function rejectedFile(): string {
  const root = process.env.BREEZE_MEMORY_DIR || path.join(stateDir(), 'memory');
  return path.join(root, 'brain-rejected-candidates.json');
}

function readRejected(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(rejectedFile(), 'utf8'));
    return new Set(Array.isArray(data) ? data.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeRejected(ids: Set<string>): void {
  try {
    const f = rejectedFile();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...ids], null, 2) + '\n');
  } catch {
    /* best-effort */
  }
}

/** The DEFAULT path for agent-driven flows: no human gate, no server call —
 *  just an explicit acknowledgement that we're leaving this candidate to the
 *  curator. Named + exported so call sites document the decision instead of
 *  silently doing nothing with a fresh candidate row. */
export function autoConfirmCandidate(row: Pick<BrainMemoryRow, 'id'>): void {
  void row; // no-op by design — see file header. Kept as a real call site hook.
}

/** Client-side-only "reject": we cannot delete/demote the row server-side (no
 *  endpoint), so we remember its id locally so the confirm/reject card never
 *  offers it again and so it's excluded defensively if it were ever fed into
 *  the active-only cache before an actual promotion happens. */
export function rejectCandidateLocally(row: Pick<BrainMemoryRow, 'id'>): void {
  const ids = readRejected();
  ids.add(row.id);
  writeRejected(ids);
}

/** True if a candidate id was previously rejected locally on this machine. */
export function isLocallyRejected(id: string): boolean {
  return readRejected().has(id);
}

/** Rows that should surface an explicit confirm/reject card: CANDIDATE-shaped
 *  rows only. brain_api's MemoryRowOut doesn't carry a `status` field today
 *  (that's a write_api/schema-internal column — candidate vs active — not
 *  echoed on the read-side row per api.py's MemoryRowOut model), so the
 *  read-side signal for "this is a candidate" is indirect: assemble_context's
 *  active-only guarantee ("Returns only active (curated) rows", api.py
 *  post_assemble_context docstring) means anything returned from
 *  /brain/context or /brain/recall is ALREADY active. The only place a
 *  candidate is visible to a client at all is the id echoed back by the
 *  WRITE-side calls (record_observation/propose_tool's `node_id`) — i.e. the
 *  thing the operator/agent itself just wrote. So "needs confirm/reject" in
 *  practice means "a row this session just proposed," not something read back
 *  from recall/context/get_tool. Call sites pass that node_id + a minimal
 *  preview through this helper rather than a full MemoryRowOut. */
export interface PendingCandidate {
  id: string;
  /** What the human is being asked to eyeball — kind + a short NON-PHI
   *  preview of the body/code the agent just proposed. */
  kind: 'memory' | 'tool';
  preview: string;
}
