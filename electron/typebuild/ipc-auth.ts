// TypeBuild auth IPC (bead fm-b5at.2, .11).
//
// Bridges the main-process auth module (auth.ts) to the renderer:
//   - typebuild:auth:signIn         (email, password) -> AuthState (throws code)
//   - typebuild:auth:signInBrowser  ()                -> AuthState (throws {code})
//   - typebuild:auth:cancelBrowser  ()                -> void
//   - typebuild:auth:signOut        ()                -> void
//   - typebuild:auth:state          ()                -> AuthState
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
import {
  BrowserAuthError,
  cancelBrowserSignIn,
  signInViaBrowser,
} from './browser-signin';

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

  // Browser sign-in (fm-b5at.11): reuse the server's OAuth flow + hosted
  // sign-in page (Google or email/password). On a typed failure we rethrow a
  // `[typebuild-browser:<code>]`-tagged Error so the renderer can map the code
  // to a user-facing state without leaking any token material.
  ipcMain.handle('typebuild:auth:signInBrowser', async () => {
    try {
      return await signInViaBrowser();
    } catch (err) {
      const code =
        err instanceof BrowserAuthError ? err.code : 'rejected';
      throw new Error(`[typebuild-browser:${code}]`);
    }
  });
  ipcMain.handle('typebuild:auth:cancelBrowser', () => {
    cancelBrowserSignIn();
  });

  ipcMain.handle('typebuild:auth:signOut', () => signOut());
  ipcMain.handle('typebuild:auth:state', () => getAuthState());

  // Push state to all windows whenever it changes (sign in/out, refresh
  // revocation, startup restore).
  onAuthStateChanged((state) => broadcast(state));

  // Best-effort: revive a persisted session. Never blocks startup; on success
  // the broadcaster above fires once the session is restored.
  void restoreSession();
}
