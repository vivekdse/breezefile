// task-ce125a047c70 — grounding bridge between New Home (NewHomePage.tsx,
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

export type NewHomeContext = {
  /** Which app surface is focused; 'other' when New Home isn't mounted. */
  surface: 'new-home' | 'other';
  /** The project the New Home picker is currently scoped to (null = All). */
  project: { id: string; name: string } | null;
  /** Every project the picker offers (id + name), so the copilot can SEE the
   *  options and pick one via the select_home_project action. NON-PHI. */
  availableProjects: { id: string; name: string }[];
  counts: Record<'done' | 'progress' | 'queued' | 'needs' | 'failed', number>;
  /** Titles + ids only (NOT bodies) of tasks in the 'needs' bucket. */
  needsYou: NeedsYouTaskSummary[];
};

const EMPTY: NewHomeContext = {
  surface: 'other',
  project: null,
  availableProjects: [],
  counts: { done: 0, progress: 0, queued: 0, needs: 0, failed: 0 },
  needsYou: [],
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

/** Called when New Home unmounts, so grounding reverts to "not on this
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
