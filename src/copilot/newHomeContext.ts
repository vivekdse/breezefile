// task-ce125a047c70 — grounding bridge between Home (NewHomePage.tsx,
// which owns the surface's live state) and the globally-mounted Copilot
// actions (actions.tsx), which need read access to that state for
// useCopilotReadable without NewHomePage importing anything from
// src/copilot/* beyond this tiny publish call + a couple of CustomEvent
// listeners (see NewHomePage.tsx). Kept as a plain module-level store +
// useSyncExternalStore hook rather than routing through the app's core
// reducer — this is ephemeral UI grounding context, not app state.
//
// NON-PHI CONTRACT: only titles + ids + counts may ride here, never task
// notes/body text/custom field values — this object is read directly into
// an LLM prompt via useCopilotReadable.
import { useSyncExternalStore } from 'react';

export type NeedsYouTaskSummary = { id: string; title: string };

/** task-7bdb94445321 — what the copilot can SEE about the inline Customize
 *  panel, so it's obvious the copilot is "looking at" the same surface the
 *  human is editing, and so it can decide whether to open/navigate it. All
 *  NON-PHI (field labels, step/chain names, rule/entry counts — configuration,
 *  never task/patient values). */
export type CustomizeContext = {
  /** Whether the inline Customize panel is currently open. */
  open: boolean;
  /** The tab shown when open (fields/columns/approvals/steps/chains/preview). */
  tab: string | null;
  /** Field labels + keys the template declares. */
  fields: { key: string; label: string }[];
  /** Step names (in order). */
  steps: string[];
  /** Approval-rule descriptions. */
  approvalRules: string[];
  /** Chain names + how many entries each has (in order). */
  chains: { id: string; name: string; entryCount: number }[];
  /** Repeatable-task templates: title + human-readable schedule (in order). */
  repeatables: { id: string; title: string; schedule: string }[];
};

export type NewHomeContext = {
  /** Which app surface is focused; 'other' when Home isn't mounted. */
  surface: 'new-home' | 'other';
  /** The project the Home picker is currently scoped to (null = All). */
  project: { id: string; name: string } | null;
  /** Every project the picker offers (id + name), so the copilot can SEE the
   *  options and pick one via the select_home_project action. NON-PHI. */
  availableProjects: { id: string; name: string }[];
  counts: Record<'done' | 'progress' | 'queued' | 'needs' | 'failed', number>;
  /** Titles + ids only (NOT bodies) of tasks in the 'needs' bucket. */
  needsYou: NeedsYouTaskSummary[];
  /** The Customize panel's live state (see CustomizeContext). */
  customize: CustomizeContext;
  /** The roster's live filter: status bucket + free-text search. NON-PHI on
   *  its own (the search STRING was typed by the user into the copilot/box). */
  rosterFilter: { status: string; search: string };
};

const EMPTY_CUSTOMIZE: CustomizeContext = {
  open: false,
  tab: null,
  fields: [],
  steps: [],
  approvalRules: [],
  chains: [],
  repeatables: [],
};

const EMPTY: NewHomeContext = {
  surface: 'other',
  project: null,
  availableProjects: [],
  counts: { done: 0, progress: 0, queued: 0, needs: 0, failed: 0 },
  needsYou: [],
  customize: EMPTY_CUSTOMIZE,
  rosterFilter: { status: 'all', search: '' },
};

let current: NewHomeContext = EMPTY;
const listeners = new Set<() => void>();

/** Called by NewHomePage whenever its selected project / counts / needs-you
 *  list change. Cheap to call often — listeners only re-render on identity
 *  change via useSyncExternalStore. */
export function setNewHomeContext(ctx: NewHomeContext): void {
  current = ctx;
  for (const l of listeners) l();
}

/** Called when Home unmounts, so grounding reverts to "not on this
 *  surface" rather than showing stale data forever. */
export function clearNewHomeContext(): void {
  setNewHomeContext(EMPTY);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): NewHomeContext {
  return current;
}

export function useNewHomeContext(): NewHomeContext {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
