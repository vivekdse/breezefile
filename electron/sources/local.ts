// LocalTaskSource (fm-b5at.1) — wraps the existing electron/tasks.ts
// sqlite store 1:1 as a TaskSource. The local store stays the backend of
// record; this is a thin adapter so the registry and IPC can treat local
// uniformly with remote sources.

import * as tasks from '../tasks';
import type { TaskCreate, TaskFilter, TaskUpdate } from '../tasks';
import { isInteractive } from '../agents/flags';
import type {
  RunNowOptions,
  SourcedTask,
  TaskSource,
  TaskSourceCapabilities,
} from '../core/task-source';

const capabilities: TaskSourceCapabilities = {
  canSchedule: true,
  canClaim: false,
  canEdit: true,
  canDelete: true,
  phiSensitive: false,
  hasFolder: true,
};

export class LocalTaskSource implements TaskSource {
  readonly id = 'local';
  readonly label = 'Local';
  readonly capabilities = capabilities;

  listTasks(filter: TaskFilter): SourcedTask[] {
    return tasks.listTasks(filter);
  }

  getTask(id: string): SourcedTask | null {
    return tasks.getTask(id);
  }

  createTask(input: TaskCreate): SourcedTask {
    return tasks.createTask(input);
  }

  updateTask(id: string, patch: TaskUpdate): SourcedTask {
    return tasks.updateTask(id, patch);
  }

  deleteTask(id: string): void {
    tasks.deleteTask(id);
  }

  async runNow(id: string, opts?: RunNowOptions): Promise<unknown> {
    const t = tasks.getTask(id);
    if (!t) throw new Error(`task not found: ${id}`);
    // fm-b5at.7 — interactive run style: open a tab with an embedded claude
    // session instead of a headless `claude -p`. Requires a GUI window to
    // host the tab; under headless breezed (no window) fall back to the
    // headless path so the run still executes.
    if (isInteractive(t.flags)) {
      const { runTaskInteractive } = await import('../agents/interactive');
      const res = await runTaskInteractive(t, {
        ...(opts?.overrideCwd ? { cwd: opts.overrideCwd } : {}),
      });
      if (res.launched) return res;
      // No window — degrade to headless below.
    }
    const { executeTaskRun } = await import('../agents/execute');
    return executeTaskRun(t, {
      manualInvocation: opts?.manualInvocation ?? true,
      ...(opts?.overrideCwd ? { overrideCwd: opts.overrideCwd } : {}),
    });
  }
}

export const localTaskSource = new LocalTaskSource();
