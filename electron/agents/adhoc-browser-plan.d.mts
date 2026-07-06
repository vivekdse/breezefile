// Type surface for the pure adhoc-browser-plan.mjs module (task-2e6c926c466c).
// Runtime is plain ESM so the node test runner can import it without a
// transpile step; TS consumers get types from here.

export const ADHOC_BROWSER_SOURCE: string;
export const ADHOC_BROWSER_LABEL: string;

export function adHocBrowserFlags(): string[];
export function adHocBrowserPrompt(): string;

export interface AdHocBrowserPlan {
  flags: string[];
  prompt: string;
  label: string;
  source: string;
}

export function buildAdHocBrowserPlan(): AdHocBrowserPlan;
