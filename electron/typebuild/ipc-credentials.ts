// Site-keyed credential vault IPC (task-d60860fb4d7f). Bridges
// site-credentials.ts to the renderer (the "Save password?" prompt's accept and
// the return-visit autofill). Server is the source of truth; main holds no
// plaintext at rest.
//
//   typebuild:cred:list    (origin?)            -> SavedCredential[]  (NO passwords)
//   typebuild:cred:resolve (origin, username)   -> string     (one password, on demand)
//   typebuild:cred:match   (origin, username, password) -> 'absent'|'match'|'differs'
//   typebuild:cred:save    ({origin,username,password}) -> {origin, username}
//   typebuild:cred:delete  (origin, username)   -> void
//
// SECURITY: the `resolve`/`save` payloads carry a password — keep it out of any
// error message and any IPC/telemetry logging. Only origin+username are safe to
// surface. Registered from electron/main.ts (sibling to registerTypebuildVaultIpc).
// Idempotent.

import { ipcMain } from 'electron';
import {
  deleteSiteCredential,
  listSiteCredentials,
  matchSiteCredential,
  resolveSiteCredential,
  saveSiteCredential,
} from './site-credentials';

let registered = false;

export function registerTypebuildCredentialsIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('typebuild:cred:list', (_e, origin?: string) =>
    listSiteCredentials(origin),
  );
  ipcMain.handle('typebuild:cred:resolve', (_e, origin: string, username: string) =>
    resolveSiteCredential(origin, username),
  );
  // task-e550e3a1f512 — compare-before-prompt: the password is compared in main
  // and only the verdict crosses back (never a stored password).
  ipcMain.handle(
    'typebuild:cred:match',
    (_e, origin: string, username: string, password: string) =>
      matchSiteCredential(origin, username, password),
  );
  ipcMain.handle(
    'typebuild:cred:save',
    (_e, cred: { origin: string; username: string; password: string }) =>
      saveSiteCredential(cred),
  );
  ipcMain.handle('typebuild:cred:delete', (_e, origin: string, username: string) =>
    deleteSiteCredential(origin, username),
  );
}
