// task-8676ddafadf0 — CopilotKit foundation: a persistent, toggleable
// right-side AI chat sidebar available on every surface of the app.
//
// Mounted once at the App root, WRAPPING the whole app shell (not just the
// sidebar panel) — task-24ea35660cd0. Any component anywhere in the app can
// then use useAgentContext/useFrontendTool/useHumanInTheLoop and share the
// SAME copilot instance the sidebar chat talks to (e.g. TaskComposer exposing
// its live field values as the human types, so the chat can see what's
// already filled in). Built on CopilotKit's v2 API
// (@copilotkit/react-core/v2) throughout — NOT the legacy v1
// useCopilotAction/useCopilotReadable/react-ui compatibility surface. When
// the main-process runtime has no Anthropic key configured, we skip mounting
// the CopilotKit provider entirely and just render children + a tiny
// setup-hint toggle — no network endpoint, no wasted client.
import { useState, type ReactNode } from 'react';
import { CopilotKit, CopilotSidebar, useAgentContext } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import './copilot-theme.css';
import { useStore } from '../store';
import { useCopilotInfo } from './useCopilotInfo';
import { CopilotActions } from './actions';
import { TaskActions } from './taskActions';
import { NavActions } from './navActions';

const APP_NAME = 'TypeBuild';

function CopilotGrounding() {
  const { state } = useStore();
  const tabKind = state.tabs[state.activeTab]?.kind ?? 'folder';

  useAgentContext({
    description: 'The name of the app the user is working in, and the kind of tab currently focused.',
    value: { appName: APP_NAME, activeTabKind: tabKind },
  });

  return (
    <>
      <CopilotActions />
      <TaskActions />
      <NavActions />
      <CopilotSidebar
        defaultOpen={false}
        position="right"
        labels={{
          modalHeaderTitle: `${APP_NAME} Copilot`,
          welcomeMessageText: "Hi! I'm your TypeBuild copilot. Ask me to help you get around, or try opening New Home.",
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

/** Mount once near the app root, WRAPPING the app shell as `children` (see
 *  file header — this is what lets e.g. TaskComposer share copilot context
 *  with the sidebar). Renders only `children` while status is loading, so
 *  the app isn't blocked on the copilot-availability probe. */
export function CopilotDock({ children }: { children: ReactNode }) {
  const info = useCopilotInfo();
  if (!info) return <>{children}</>;

  if (!info.enabled || !info.port) {
    return (
      <>
        {children}
        <div className="copilot-dock copilot-dock--disabled">
          <SetupHintToggle />
        </div>
      </>
    );
  }

  const runtimeUrl = `http://127.0.0.1:${info.port}${info.endpoint ?? '/copilotkit'}`;

  return (
    <CopilotKit runtimeUrl={runtimeUrl} useSingleEndpoint>
      {children}
      <div className="copilot-dock">
        <CopilotGrounding />
      </div>
    </CopilotKit>
  );
}
