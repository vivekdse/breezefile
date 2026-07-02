// task-8676ddafadf0 — CopilotKit foundation: a persistent, toggleable
// right-side AI chat sidebar available on every surface of the app.
//
// Mounted once at the App root (inside StoreProvider so it can read the
// current tab kind for useCopilotReadable). When the main-process runtime
// has no Anthropic key configured, we skip mounting the CopilotKit provider
// entirely and render a tiny toggle that just shows a one-line setup hint —
// no network endpoint, no wasted GraphQL client.
import { useState } from 'react';
import { CopilotKit, useCopilotAction, useCopilotReadable } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import './copilot-theme.css';
import { useStore } from '../store';
import { useCopilotInfo } from './useCopilotInfo';
import { CopilotActions } from './actions';

const APP_NAME = 'TypeBuild';

function CopilotSidebarPanel() {
  const { state } = useStore();
  const tabKind = state.tabs[state.activeTab]?.kind ?? 'folder';

  useCopilotReadable({
    description: 'The name of the app the user is working in, and the kind of tab currently focused.',
    value: { appName: APP_NAME, activeTabKind: tabKind },
  });

  useCopilotAction({
    name: 'open_new_home',
    description: 'Open the New Home page — the app launch surface with recent tasks and projects.',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('fm:openNewHome'));
    },
  });

  return (
    <>
      <CopilotActions />
      <CopilotSidebar
        defaultOpen={false}
        clickOutsideToClose={false}
        labels={{
          title: `${APP_NAME} Copilot`,
          initial: "Hi! I'm your TypeBuild copilot. Ask me to help you get around, or try opening New Home.",
        }}
      />
    </>
  );
}

function SetupHintToggle() {
  const [open, setOpen] = useState(false);
  return (
    <div className="copilot-dock__standalone">
      <button
        type="button"
        className="copilot-dock__launcher"
        aria-label="AI copilot (not configured)"
        title="AI copilot — no Anthropic API key configured"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>✨</span>
      </button>
      {open && (
        <div className="copilot-dock__setup-hint" role="dialog">
          Copilot needs an Anthropic API key. Set <code>ANTHROPIC_API_KEY</code> in
          the environment, or configure a key the same way the tag-assist NL
          box does, then relaunch.
        </div>
      )}
    </div>
  );
}

/** Mount once near the app root. Renders nothing while status is loading. */
export function CopilotDock() {
  const info = useCopilotInfo();
  if (!info) return null;

  if (!info.enabled || !info.port) {
    return (
      <div className="copilot-dock copilot-dock--disabled">
        <SetupHintToggle />
      </div>
    );
  }

  const runtimeUrl = `http://127.0.0.1:${info.port}${info.endpoint ?? '/copilotkit'}`;

  return (
    <div className="copilot-dock">
      <CopilotKit runtimeUrl={runtimeUrl}>
        <CopilotSidebarPanel />
      </CopilotKit>
    </div>
  );
}
