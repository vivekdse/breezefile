// TypeBuild onboarding checklist (bead fm-b5at.3).
//
// Presentational only — all detection/IPC lives in the parent; this renders
// the four prerequisite steps from props and surfaces the Install / Re-check
// actions via callbacks. Wired up by the integration bead.

import './OnboardingChecklist.css';

const CHROME_EXTENSION_URL = 'https://claude.ai/chrome';

type Props = {
  checks: {
    signedIn: boolean;
    claude: boolean;
    chrome: boolean;
    extensionConfirmed: boolean;
  };
  onRecheck: () => void;
  onInstallClaude: () => void;
  onToggleExtensionConfirmed: (v: boolean) => void;
};

export function OnboardingChecklist({
  checks,
  onRecheck,
  onInstallClaude,
  onToggleExtensionConfirmed,
}: Props) {
  return (
    <div className="onboarding">
      <div className="onboarding__title">Before you start</div>
      <ol className="onboarding__list">
        <Step n={1} ok={checks.signedIn} label="Signed in to TypeBuild" />

        <Step n={2} ok={checks.claude} label="Claude Code installed">
          {!checks.claude && (
            <button
              type="button"
              className="onboarding__install"
              onClick={onInstallClaude}
            >
              Install
            </button>
          )}
        </Step>

        <Step n={3} ok={checks.chrome} label="Google Chrome installed" />

        <Step
          n={4}
          ok={checks.extensionConfirmed}
          label="Claude-in-Chrome extension"
        >
          <label className="onboarding__confirm">
            <input
              type="checkbox"
              checked={checks.extensionConfirmed}
              onChange={(e) => onToggleExtensionConfirmed(e.target.checked)}
            />
            <span>I've installed it</span>
          </label>
          <a
            className="onboarding__link"
            href={CHROME_EXTENSION_URL}
            target="_blank"
            rel="noreferrer"
          >
            Get the extension
          </a>
        </Step>
      </ol>

      <div className="onboarding__actions">
        <button
          type="button"
          className="onboarding__recheck"
          onClick={onRecheck}
        >
          Re-check
        </button>
      </div>
    </div>
  );
}

function Step({
  n,
  ok,
  label,
  children,
}: {
  n: number;
  ok: boolean;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <li
      className={[
        'onboarding__step',
        ok ? 'onboarding__step--ok' : 'onboarding__step--pending',
      ].join(' ')}
    >
      <span className="onboarding__mark" aria-hidden>
        {ok ? '✓' : n}
      </span>
      <span className="onboarding__label">{label}</span>
      {children && <span className="onboarding__step-actions">{children}</span>}
    </li>
  );
}
