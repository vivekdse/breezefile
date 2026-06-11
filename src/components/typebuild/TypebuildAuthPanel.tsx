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

import { useCallback, useEffect, useState } from 'react';
import { fm, type TypebuildAuthState } from '../../bridge';
import { useStore, makeTab } from '../../store';
import { spawnTerminal } from '../../terminalSpawn';
import { OnboardingChecklist } from './OnboardingChecklist';
import './TypebuildAuthPanel.css';

// Renderer-local, PHI-free flag: the user attests the Claude-in-Chrome
// extension is installed (we can't reliably detect it). Boolean only — never
// task content.
const EXTENSION_CONFIRMED_KEY = 'fm.typebuild.extensionConfirmed';

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
        <TypebuildOnboarding signedIn={authState.signedIn} />
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
      <TypebuildOnboarding signedIn={authState.signedIn} />
    </div>
  );
}

// Live-data wrapper around the presentational OnboardingChecklist. Owns
// prerequisite detection (Claude / Chrome via main), the renderer-local
// "extension confirmed" attestation, and the Install action that opens a
// terminal tab running the install command and re-checks when it exits.
function TypebuildOnboarding({ signedIn }: { signedIn: boolean }) {
  const { state, dispatch } = useStore();
  const [claude, setClaude] = useState(false);
  const [chrome, setChrome] = useState(false);
  const [extensionConfirmed, setExtensionConfirmed] = useState(false);

  const recheck = useCallback(async () => {
    try {
      const res = await fm.typebuild.detectChecks();
      setClaude(res.claude.ok);
      setChrome(res.chrome.ok);
    } catch {
      // Detection failure leaves the prior (or default-false) state; the
      // user can Re-check again.
    }
  }, []);

  // Detect on mount and read the persisted extension attestation.
  useEffect(() => {
    void recheck();
    try {
      if (typeof localStorage !== 'undefined') {
        setExtensionConfirmed(
          localStorage.getItem(EXTENSION_CONFIRMED_KEY) === '1',
        );
      }
    } catch {
      // ignore unavailable storage
    }
  }, [recheck]);

  const onToggleExtensionConfirmed = useCallback((v: boolean) => {
    setExtensionConfirmed(v);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(EXTENSION_CONFIRMED_KEY, v ? '1' : '0');
      }
    } catch {
      // ignore unavailable storage
    }
  }, []);

  // Open a terminal tab rooted at $HOME, run the install command in it, and
  // re-run the prerequisite checks once that pty exits so the checklist
  // reflects the freshly-installed Claude. Uses spawnTerminal (no shell
  // override → user's login shell; respects the tmux setting) and writes the
  // command in, so there is no platform-specific shell handling here.
  const onInstallClaude = useCallback(async () => {
    let command: string;
    let home: string;
    try {
      [command, home] = await Promise.all([
        fm.typebuild.installCommand(),
        fm.homedir(),
      ]);
    } catch {
      dispatch({ type: 'setStatus', msg: 'could not start Claude install' });
      return;
    }
    try {
      const ptyId = await spawnTerminal({
        cwd: home,
        sessionLabel: 'install-claude',
      });
      const tabIndex = state.tabs.length;
      dispatch({ type: 'newTab', tab: makeTab(home) });
      dispatch({
        type: 'openTerminal',
        tabIndex,
        ptyId,
        cwd: home,
        label: 'Install Claude',
      });
      dispatch({ type: 'setStatus', msg: 'installing Claude Code…' });
      // Re-check prerequisites once the install pty exits.
      const off = fm.onTermExit((id) => {
        if (id !== ptyId) return;
        off();
        void recheck();
      });
      // Let the shell finish its startup before feeding the command.
      setTimeout(() => {
        fm.termWrite(ptyId, command + '\r');
      }, 250);
    } catch {
      dispatch({ type: 'setStatus', msg: 'could not open install terminal' });
    }
  }, [dispatch, state.tabs.length, recheck]);

  return (
    <OnboardingChecklist
      checks={{ signedIn, claude, chrome, extensionConfirmed }}
      onRecheck={() => void recheck()}
      onInstallClaude={() => void onInstallClaude()}
      onToggleExtensionConfirmed={onToggleExtensionConfirmed}
    />
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
