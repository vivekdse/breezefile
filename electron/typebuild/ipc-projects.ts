// TypeBuild Projects IPC (task-ab1d7955e23f). Bridges the TypeBuild source's
// project REST methods to the renderer. Projects are named containers with
// optional instructions + a set of owned folders.
//
//   typebuild:projects:list       (includeArchived?) -> Project[]
//   typebuild:projects:get        (id, effective?)   -> Project | null
//   typebuild:projects:resolve    (folder)           -> Project | null
//   typebuild:projects:create     (input)            -> Project
//   typebuild:projects:patch      (id, patch)        -> { ok, project | reason }
//   typebuild:tasks:note          (taskId, note)     -> { ok, reason? }
//   typebuild:projects:archive    (id)               -> Project   (task-2c5448be520a)
//   typebuild:projects:unarchive  (id)               -> Project
//
// task-fdf3dc6b3c5c — projects:patch + tasks:note bridge the teach-in-the-moment
// write-back: PROJECT scope → projects:patch (PATCH instructions; owner-only/
// PHI-guarded), TASK scope → tasks:note (per-task teach note). Both return a
// STRUCTURED result the renderer surfaces (so a 403/422 shows a message, never
// crashes). task-2c5448be520a — archive/unarchive hide projects from the list.
//
// NON-PHI: project name/description/instructions/folders are not patient data.
// The source still never logs request/response bodies. Registered from
// electron/main.ts (sibling to registerTypebuildVaultIpc). Idempotent.
//
// The source instance is resolved through the same registry accessor the
// tasks:* handlers use (getTaskSource('typebuild')); when signed out the source
// is unregistered, so we surface a clean error rather than a null deref.

import { ipcMain } from 'electron';
import { getTaskSource } from '../sources/registry';
import type { Agent, Project, TypeBuildTaskSource } from '../sources/typebuild';

let registered = false;

function source(): TypeBuildTaskSource {
  const src = getTaskSource('typebuild') as TypeBuildTaskSource | undefined;
  if (!src) {
    throw new Error('typebuild: not signed in (projects unavailable)');
  }
  return src;
}

export function registerTypebuildProjectsIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'typebuild:projects:list',
    (_e, includeArchived?: boolean): Promise<Project[]> =>
      source().listProjects({ includeArchived: !!includeArchived }),
  );
  // task-896f3f7f5e75 — the AGENT registry for the composer's agent picker.
  // NON-PHI (agent names/tools/launch_mode). Mirrors projects:list; the source
  // returns [] on a parse miss and drops malformed rows, so the picker degrades
  // to a None-only list rather than crashing.
  ipcMain.handle(
    'typebuild:agents:list',
    (_e): Promise<Agent[]> => source().listAgents(),
  );
  ipcMain.handle(
    'typebuild:projects:get',
    (_e, id: string, effective?: boolean): Promise<Project | null> =>
      source().getProject(id, { effective: !!effective }),
  );
  ipcMain.handle(
    'typebuild:projects:resolve',
    (_e, folder: string): Promise<Project | null> =>
      source().resolveProjectFolder(folder),
  );
  ipcMain.handle(
    'typebuild:projects:create',
    (
      _e,
      input: {
        name: string;
        description?: string;
        instructions?: string;
        parentProjectId?: string;
        folders?: string[];
      },
    ): Promise<Project> => source().createProject(input),
  );
  // task-fdf3dc6b3c5c — PROJECT-scope teach write-back. Returns a structured
  // result ({ ok:false, reason } on owner/PHI/visibility failures) so the
  // renderer keeps its local fallback and shows a clear message, not a crash.
  ipcMain.handle(
    'typebuild:projects:patch',
    (
      _e,
      id: string,
      patch: { name?: string; description?: string; instructions?: string },
    ) => source().updateProject(id, patch),
  );
  // task-fdf3dc6b3c5c — TASK-scope teach write-back (per-task note). Same
  // structured-result contract.
  ipcMain.handle(
    'typebuild:tasks:note',
    (_e, taskId: string, note: string) => source().addTaskNote(taskId, note),
  );
  // task-da23979fd907 — append to the USER-facing task message feed. NOT
  // claim-gated (unlike tasks:note): anyone who can see the task may post. Same
  // STRUCTURED { ok:false, reason } contract so the compose box surfaces 400
  // (empty) / 404 (not_visible) without crashing.
  ipcMain.handle(
    'typebuild:tasks:message',
    (_e, taskId: string, text: string) => source().postTaskMessage(taskId, text),
  );
  // task-a763ca5be676 — answer a task's PENDING QUESTION (ask_user). Clears
  // pending_question + records the reply on the message feed server-side. Same
  // STRUCTURED { ok:false, reason } contract so the inline reply box surfaces 409
  // (no_pending_question) / 404 (not_visible) / 400 (empty) without crashing.
  // PHI: `answer` is sent to the server but never logged.
  ipcMain.handle(
    'typebuild:tasks:answer',
    (_e, taskId: string, answer: string) => source().answerQuestion(taskId, answer),
  );
  // task-2c5448be520a — archive/unarchive. Distinct verbs (NOT a generic
  // update PATCH, which a sibling task owns) so the two write paths don't clash.
  ipcMain.handle(
    'typebuild:projects:archive',
    (_e, id: string): Promise<Project> => source().archiveProject(id),
  );
  ipcMain.handle(
    'typebuild:projects:unarchive',
    (_e, id: string): Promise<Project> => source().unarchiveProject(id),
  );
}
