// TypeBuild auth IPC (bead fm-b5at.2).
//
// Bridges the main-process auth module (auth.ts) to the renderer:
//   - typebuild:auth:signIn  (email, password) -> AuthState   (throws on error)
//   - typebuild:auth:signOut  ()               -> void
//   - typebuild:auth:state    ()               -> AuthState
//   - broadcast `typebuild:auth:changed` to every window on state change.
//
// Registered from electron/main.ts (not ipc.ts — that file is owned by a
// parallel agent). Also kicks off restoreSession() so a persisted refresh
// token revives the session on launch.

import { BrowserWindow, ipcMain } from 'electron';
import {
  getAuthState,
  onAuthStateChanged,
  restoreSession,
  signIn,
  signOut,
  type AuthState,
} from './auth';

let registered = false;

function broadcast(state: AuthState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('typebuild:auth:changed', state);
  }
}

/**
 * Register the TypeBuild auth IPC handlers + the state-change broadcaster, and
 * restore any persisted session. Idempotent.
 */
export function registerTypebuildAuthIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'typebuild:auth:signIn',
    (_e, email: string, password: string) => signIn(email, password),
  );
  ipcMain.handle('typebuild:auth:signOut', () => signOut());
  ipcMain.handle('typebuild:auth:state', () => getAuthState());

  // Push state to all windows whenever it changes (sign in/out, refresh
  // revocation, startup restore).
  onAuthStateChanged((state) => broadcast(state));

  // Best-effort: revive a persisted session. Never blocks startup; on success
  // the broadcaster above fires once the session is restored.
  void restoreSession();
}
