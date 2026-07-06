// Pure launch-plan for the task-less ad-hoc Ctrl+B browser session
// (task-2e6c926c466c).
//
// Runtime is plain ESM (a .mjs sibling with a .d.mts type surface) so the node
// test runner can import + assert it with no transpile step — mirrors the
// typebuild-wire.mjs / startOutcome.mjs pattern in this repo. It holds ONLY the
// pure, PHI-free constants + prompt text; the electron-coupled runner that
// actually spawns the session lives in electron/agents/adhoc-browser.ts and
// feeds this plan into the SHARED runTaskInteractive path.

// Source id tagged on the run so the renderer + the Stop backstop can tell an
// ad-hoc browser session apart from a TypeBuild task session. NOT 'typebuild'
// (that source is PHI-sensitive / ask_user-capable — this session is neither).
export const ADHOC_BROWSER_SOURCE = 'adhoc-browser';

// Generic, content-free tab/terminal label. There is no task, so nothing here
// is (or could be) PHI.
export const ADHOC_BROWSER_LABEL = 'Browser';

// Flags fed to the shared launcher:
//   playwright  — SPIKE (spike/playwright-cdp): opens the operator browser
//                 window and points the helper CLIs at Breeze's CDP endpoint,
//                 exactly as a TypeBuild browser task does. This is the wiring
//                 that lets the agent actually DRIVE the browser.
//   auto        — --permission-mode auto: browser driving is all Bash (the
//                 helper CLI), so without this every call would prompt.
//   interactive — selects the embedded-terminal run style (no-op for argv).
export function adHocBrowserFlags() {
  return ['playwright', 'auto', 'interactive'];
}

// The agent's opening turn. GENERIC browser-driving instructions only — there
// is no task, so this carries no task context and no PHI. The full browser
// playbook (selectors / fast paths / gotchas) still auto-loads from the
// workspace CLAUDE.md (cwd=TASKS_DIR) and the global operator-instructions
// addendum, same as a task session — this line just tells the agent what it is
// attached to and to wait for the user.
export function adHocBrowserPrompt() {
  return [
    "You are attached to the user's browser via the embedded browser helper CLI.",
    'Drive it as the user asks — navigate, click, fill forms, read pages, and',
    'report what you see. There is no assigned task: wait for the user to tell',
    'you what they want done, then use the browser to do it. Never submit a form',
    'or take an irreversible action without explicit confirmation from the user.',
  ].join(' ');
}

// The whole plan in one object (convenience for the runner + the test).
export function buildAdHocBrowserPlan() {
  return {
    flags: adHocBrowserFlags(),
    prompt: adHocBrowserPrompt(),
    label: ADHOC_BROWSER_LABEL,
    source: ADHOC_BROWSER_SOURCE,
  };
}
