// User credential vault IPC (:secrets panel). Bridges user-vault.ts to the
// renderer. Class-2 data — the user's OWN identifiers (NPI, Tax ID, login IDs).
// Server is the source of truth; main holds no plaintext at rest.
//
//   typebuild:vault:list    ()              -> string[]   (KEY names only)
//   typebuild:vault:reveal  (ref)           -> string     (one value, on demand)
//   typebuild:vault:set     (key, value)    -> string     (canonical ref written)
//   typebuild:vault:delete  (ref)           -> void
//
// SECURITY: never log a value; the `reveal`/`set` payloads carry secrets, so
// keep them out of any error message and any IPC/telemetry logging. Only key
// names are safe to surface. Registered from electron/main.ts (sibling to
// registerTypebuildAuthIpc). Idempotent.

import { ipcMain } from 'electron';
import {
  deleteUserSecret,
  listUserSecrets,
  revealUserSecret,
  setUserSecret,
} from './user-vault';

let registered = false;

export function registerTypebuildVaultIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('typebuild:vault:list', () => listUserSecrets());
  ipcMain.handle('typebuild:vault:reveal', (_e, ref: string) => revealUserSecret(ref));
  ipcMain.handle('typebuild:vault:set', (_e, key: string, value: string) =>
    setUserSecret(key, value),
  );
  ipcMain.handle('typebuild:vault:delete', (_e, ref: string) => deleteUserSecret(ref));
}
