// TypeBuild sign-in panel (bead fm-b5at.2).
//
// Rendered inside the Settings "TypeBuild" accordion section. Signed-out:
// email + password fields + Sign in button + error display. Signed-in: shows
// the email + a Sign out button. Token lifecycle lives entirely in main
// (electron/typebuild/auth.ts); this panel only ever sees AuthState.
//
// SECURITY: the password is held in component state only for the duration of a
// sign-in attempt and is cleared immediately afterwards (success or failure);
// it is never persisted or logged.

import { useEffect, useState } from 'react';
import { fm, type TypebuildAuthState } from '../../bridge';
import './TypebuildAuthPanel.css';

export function TypebuildAuthPanel() {
  const [authState, setAuthState] = useState<TypebuildAuthState>({
    signedIn: false,
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Hydrate from main on open, then subscribe to broadcast changes (sign
  // in/out, refresh revocation, startup restore).
  useEffect(() => {
    let alive = true;
    void fm.typebuild
      .authState()
      .then((s) => {
        if (alive) setAuthState(s);
      })
      .catch(() => {});
    const off = fm.typebuild.onAuthChanged((s) => {
      if (alive) setAuthState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await fm.typebuild.signIn(email.trim(), password);
      setAuthState(next);
      setEmail('');
    } catch (err) {
      setError(friendlyError((err as Error).message));
    } finally {
      // Always clear the password — never keep it in state past the attempt.
      setPassword('');
      setBusy(false);
    }
  }

  async function onSignOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fm.typebuild.signOut();
      setAuthState({ signedIn: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (authState.signedIn) {
    return (
      <div className="tb-auth">
        <div className="settings__row">
          <span className="settings__action">Signed in</span>
          <span className="settings__path tb-auth__email">
            {authState.email ?? '—'}
          </span>
        </div>
        <div className="tb-auth__actions">
          <button
            type="button"
            className="tb-auth__btn"
            onClick={() => void onSignOut()}
            disabled={busy}
          >
            Sign out
          </button>
        </div>
        {/* Onboarding checklist mounts here in a later bead (fm-b5at.3). */}
        {/* <TypebuildOnboardingChecklist /> */}
      </div>
    );
  }

  return (
    <div className="tb-auth">
      <p className="settings__hint tb-auth__intro">
        Sign in to the TypeBuild task backend with your Firebase email and
        password. Your sign-in is remembered securely so you only do this once.
      </p>
      <form className="tb-auth__form" onSubmit={onSignIn}>
        <label className="tb-auth__field">
          <span className="tb-auth__label">Email</span>
          <input
            type="email"
            className="tb-auth__input"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={busy}
          />
        </label>
        <label className="tb-auth__field">
          <span className="tb-auth__label">Password</span>
          <input
            type="password"
            className="tb-auth__input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={busy}
          />
        </label>
        {error && (
          <div className="tb-auth__error" role="alert">
            {error}
          </div>
        )}
        <div className="tb-auth__actions">
          <button
            type="submit"
            className="tb-auth__btn tb-auth__btn--primary"
            disabled={busy || !email.trim() || !password}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
      {/* Onboarding checklist mounts here in a later bead (fm-b5at.3). */}
      {/* <TypebuildOnboardingChecklist /> */}
    </div>
  );
}

// Translate a few common Firebase Identity Toolkit error codes into readable
// copy; everything else passes through as-is.
function friendlyError(code: string): string {
  switch (code) {
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_PASSWORD':
    case 'EMAIL_NOT_FOUND':
      return 'Incorrect email or password.';
    case 'USER_DISABLED':
      return 'This account has been disabled.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'Too many attempts. Please try again later.';
    case 'MISSING_PASSWORD':
      return 'Please enter your password.';
    case 'INVALID_EMAIL':
      return 'That email address looks invalid.';
    default:
      return code || 'Sign-in failed. Please try again.';
  }
}
