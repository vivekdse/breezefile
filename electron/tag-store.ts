// task-317c7fe41f90 — main-side owner of the DSL-tag JSON store.
//
// The pure persistence layer (src/tagStore.mjs, fm-a2k) takes an injectable
// config dir; per tagStore.mjs:35-36 the Electron host passes its own
// app.getPath('userData') so tags.json sits next to openwith.json /
// launchers.json / terminal.json rather than in the cross-platform ~/.config
// fallback. This module instantiates ONE store bound there and registers the
// dsltags:* IPC handlers the renderer reaches through window.fm.dslTags.*.
//
// This is the LOW-RISK, ADDITIVE path chosen for the foundation task: it runs
// ALONGSIDE the existing live criterion tag system (Redux/localStorage) rather
// than replacing it. Nothing here touches the criterion store.

import { app, ipcMain } from 'electron';
import { TagStore } from '../src/tagStore.mjs';
import type { Tag, TagCreate, TagUpdate } from '../src/tagStore.d.mts';

let store: TagStore | null = null;

/** The single store, bound lazily to userData/tags.json on first use (app
 *  must be ready for getPath('userData')). */
function tagStore(): TagStore {
  if (!store) store = new TagStore({ dir: app.getPath('userData') });
  return store;
}

/** Register the DSL-tag store IPC. Call once from registerIpc(). */
export function registerTagStoreIpc(): void {
  ipcMain.handle('dsltags:list', async (): Promise<Tag[]> => {
    return tagStore().list();
  });
  ipcMain.handle('dsltags:get', async (_e, id: string): Promise<Tag | null> => {
    return tagStore().getById(id);
  });
  ipcMain.handle('dsltags:create', async (_e, input: TagCreate): Promise<Tag> => {
    return tagStore().create(input);
  });
  ipcMain.handle(
    'dsltags:update',
    async (_e, id: string, patch: TagUpdate): Promise<Tag | null> => {
      return tagStore().update(id, patch);
    },
  );
  ipcMain.handle('dsltags:delete', async (_e, id: string): Promise<boolean> => {
    return tagStore().delete(id);
  });
}
