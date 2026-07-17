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
import { resolveTaskDataRef, resolveTaskDataBulk, patchTaskData } from './task-data';

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

  // task-780730a010a2 follow-up — the IN-column BULK display read: one call
  // per TASK instead of one per (taskId,key). Same best-effort, never-throw
  // discipline as resolve() above (a missing/failed key is simply absent from
  // the returned map) — see resolveTaskDataBulk for the local-cache-first,
  // network-only-for-misses mechanics.
  ipcMain.handle(
    'typebuild:data:resolveBulk',
    async (_e, taskId: string, keys: string[], format?: string): Promise<Record<string, string>> => {
      if (!taskId || !Array.isArray(keys) || keys.length === 0) return {};
      try {
        return await resolveTaskDataBulk(taskId, keys, format);
      } catch {
        return {};
      }
    },
  );

  // task-4a8d2c98f667 — the drawer's Inputs section EDIT/ADD path. Unlike
  // resolve (best-effort, degrades to null), a patch failure IS surfaced to
  // the renderer as a structured result (not a throw) so the Inputs editor
  // can show a clear save error / permission message instead of silently
  // no-op'ing. See task-data.ts patchTaskData for the resolve-merge-replace
  // mechanics and why this must happen in ONE main-process call.
  ipcMain.handle(
    'typebuild:data:patch',
    async (
      _e,
      taskId: string,
      upsert: Record<string, string>,
      deleteKeys: string[],
      knownSiblingKeys: string[],
    ): Promise<{ ok: true; droppedKeys: string[] } | { ok: false; status?: number; error: string }> => {
      if (!taskId) return { ok: false, error: 'taskId required' };
      try {
        return await patchTaskData(
          taskId,
          upsert && typeof upsert === 'object' ? upsert : {},
          Array.isArray(deleteKeys) ? deleteKeys : [],
          Array.isArray(knownSiblingKeys) ? knownSiblingKeys : [],
        );
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
}
