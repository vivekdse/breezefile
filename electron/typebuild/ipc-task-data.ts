// task-1af4f59428eb (New Home follow-up #1) — task `data` (class-1 PHI) IPC for
// the RENDERER'S OWN display needs (New Home's TaskDetailDialog "Details" grid),
// distinct from the browser-agent fill path (electron/api-server.ts `/app/task-data`,
// used by cli.mjs `fill-ref`/`type-ref`). Same resolver underneath
// (`resolveTaskDataRef`), same one-ref-per-call / never-cache / never-log
// discipline — just a second caller (the New Home UI, not the agent helper).
//
//   typebuild:data:resolve  (taskId, ref)  -> string | null
//
// Returns `null` (not a throw) on "no data for this ref" (404-equivalent —
// resolveTaskDataRef's 404/empty-value cases) so the renderer can render a
// field as simply absent, matching the existing task.customValues[key]
// "undefined = show em-dash" convention (RosterTable/TaskDetailDialog). Any
// OTHER failure (network/auth/5xx) also resolves to null — this is a
// best-effort DISPLAY read, not a fill; the UI must never crash or block on it.
//
// SECURITY: never log the resolved value or the request in any error message;
// only the opaque ref/taskId (non-PHI ids) are safe to surface. Registered from
// electron/main.ts (sibling to registerTypebuildVaultIpc). Idempotent.

import { ipcMain } from 'electron';
import { resolveTaskDataRef } from './task-data';

let registered = false;

export function registerTypebuildTaskDataIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'typebuild:data:resolve',
    async (_e, taskId: string, ref: string): Promise<string | null> => {
      if (!taskId || !ref) return null;
      try {
        return await resolveTaskDataRef(taskId, ref);
      } catch {
        // 404 (no data for ref) / empty-value / transport / auth failures all
        // degrade to "no value to show" — never surface the underlying error
        // (which could echo the ref but never a value) to the renderer as a
        // thrown rejection that a display read has to special-case.
        return null;
      }
    },
  );
}
