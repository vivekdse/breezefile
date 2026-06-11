// TaskSource registry (fm-b5at.1).
//
// Holds the live set of registered TaskSources keyed by id. The local
// sqlite source is registered at startup (registerDefaultSources); remote
// sources (TypeBuild) register themselves when they connect and
// unregister on disconnect. The tasks:* IPC handlers route by source id
// through this registry.
//
// Distinct from electron/sources.ts (the breezed per-machine federation),
// which stays a parallel path — those hosts are reached over ssh tunnels,
// not wrapped as TaskSources here.

import type { TaskSource, TaskSourceInfo } from '../core/task-source';
import { describeSource } from '../core/task-source';
import { localTaskSource } from './local';

const registry = new Map<string, TaskSource>();

export function registerTaskSource(source: TaskSource): void {
  registry.set(source.id, source);
}

export function unregisterTaskSource(id: string): void {
  registry.delete(id);
}

export function getTaskSource(id?: string): TaskSource | undefined {
  return registry.get(id ?? 'local');
}

export function listTaskSources(): TaskSource[] {
  return [...registry.values()];
}

export function listTaskSourceInfos(): TaskSourceInfo[] {
  return listTaskSources().map(describeSource);
}

/** Register the always-present local source. Called once at startup. */
export function registerDefaultSources(): void {
  if (!registry.has(localTaskSource.id)) registerTaskSource(localTaskSource);
}

// The local source is always available, even before registerDefaultSources
// runs (e.g. in tools/tests that import the registry directly).
registerDefaultSources();
