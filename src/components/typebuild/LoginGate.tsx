// Full-screen login gate: the app is unusable while signed out. Shown by
// Shell() in place of the main UI whenever useTypebuildAuth() reports
// signedIn === false. Sign-in itself opens a small in-app browser window
// (electron/typebuild/browser-signin.ts's openLoginWindow) — never the
// system browser — since the user hasn't gotten into the app yet.

import { useState } from 'react';
import { fm } from '../../bridge';
import '../typebuild/TypebuildAuthPanel.css';
import './LoginGate.css';

export function LoginGate() {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    if (waiting) return;
    setWaiting(true);
    setError(null);
    try {
      await fm.typebuild.signInBrowser();
      // Success flips useTypebuildAuth() via the onAuthChanged broadcast;
      // this component unmounts once Shell() re-renders.
    } catch (err) {
      const code = browserErrorCode((err as Error).message);
      if (code !== 'cancelled') setError(friendlyError(code));
    } finally {
      setWaiting(false);
    }
  }

  function onCancel() {
    void fm.typebuild.cancelBrowser();
    setWaiting(false);
  }

  return (
    <div className="login-gate">
      <div className="login-gate__card">
        <h1 className="login-gate__title">TypeBuild</h1>
        <p className="login-gate__intro">Sign in to get started.</p>
        <div className="tb-auth__actions login-gate__actions">
          {waiting ? (
            <>
              <span className="settings__hint tb-auth__waiting">
                Waiting for sign-in…
              </span>
              <button type="button" className="tb-auth__btn" onClick={onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tb-auth__btn tb-auth__btn--primary"
              onClick={() => void onSignIn()}
            >
              Sign in
            </button>
          )}
        </div>
        {error && (
          <div className="tb-auth__error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function browserErrorCode(message: string): string {
  const m = /\[typebuild-browser:([a-z-]+)\]/.exec(message);
  return m ? m[1] : 'rejected';
}

function friendlyError(code: string): string {
  switch (code) {
    case 'unreachable':
      return "Couldn't reach TypeBuild. Check your connection and try again.";
    case 'server-pending':
      return 'TypeBuild server update pending — please try again shortly.';
    case 'rejected':
      return 'Sign-in was rejected. Please try again.';
    case 'timeout':
      return 'Sign-in timed out — the sign-in page never completed. Try again.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}
