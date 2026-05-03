// Agent registry. Single source of truth for which AgentRunners the
// scheduler can dispatch to. Agents register themselves at module load
// (see ./index.ts).

import type { AgentId, AgentRunner } from './types';

const runners = new Map<AgentId, AgentRunner>();

export function registerAgent(runner: AgentRunner): void {
  if (runners.has(runner.id)) {
    throw new Error(`agent already registered: ${runner.id}`);
  }
  runners.set(runner.id, runner);
}

export function getAgent(id: AgentId): AgentRunner | null {
  return runners.get(id) ?? null;
}

export function listAgents(): AgentRunner[] {
  return [...runners.values()];
}

/** The agent used when a task has auto_mode=true but auto_agent=null.
 *  First registered runner wins (claude in v1). */
export function defaultAgentId(): AgentId | null {
  const first = runners.values().next();
  return first.done ? null : first.value.id;
}
