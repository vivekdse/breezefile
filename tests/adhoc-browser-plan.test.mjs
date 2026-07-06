// Unit coverage for the pure ad-hoc (task-less) Ctrl+B browser launch plan
// (task-2e6c926c466c). The electron-coupled runner (adhoc-browser.ts) can't be
// exercised without a window + pty, but the PLAN it feeds into the shared
// runTaskInteractive path is pure and PHI-free — assert its contract here so a
// regression (wrong flags → no CDP wiring, or task text leaking into the
// prompt) is caught without launching anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adHocBrowserFlags,
  adHocBrowserPrompt,
  buildAdHocBrowserPlan,
  ADHOC_BROWSER_LABEL,
  ADHOC_BROWSER_SOURCE,
} from '../electron/agents/adhoc-browser-plan.mjs';

test('flags carry `playwright` (the CDP + operator-window wiring)', () => {
  const flags = adHocBrowserFlags();
  assert.ok(
    flags.includes('playwright'),
    'the `playwright` flag is what opens the operator window and points the ' +
      'helper CLIs at CDP — without it the agent cannot drive the browser',
  );
});

test('flags carry `auto` so browser (Bash) driving runs unattended', () => {
  assert.ok(adHocBrowserFlags().includes('auto'));
});

test('flags carry `interactive` (the embedded-terminal run style)', () => {
  assert.ok(adHocBrowserFlags().includes('interactive'));
});

test('source is NOT the PHI-sensitive typebuild source', () => {
  assert.equal(ADHOC_BROWSER_SOURCE, 'adhoc-browser');
  assert.notEqual(ADHOC_BROWSER_SOURCE, 'typebuild');
});

test('label is generic and content-free', () => {
  assert.equal(ADHOC_BROWSER_LABEL, 'Browser');
});

test('prompt is generic browser-driving instructions — no task/PHI', () => {
  const prompt = adHocBrowserPrompt();
  assert.ok(prompt.length > 0);
  // It must tell the agent it is attached to the browser and to wait for the
  // user — i.e. generic, no task context baked in.
  assert.match(prompt, /browser/i);
  assert.match(prompt, /wait for the user|the user/i);
  // Guardrail against irreversible actions must be present.
  assert.match(prompt, /confirm|irreversible/i);
  // Sanity: no task-shaped tokens leaked into the generic prompt.
  assert.doesNotMatch(prompt, /task-[0-9a-f]{12}/i);
});

test('buildAdHocBrowserPlan bundles the same pieces consistently', () => {
  const plan = buildAdHocBrowserPlan();
  assert.deepEqual(plan.flags, adHocBrowserFlags());
  assert.equal(plan.prompt, adHocBrowserPrompt());
  assert.equal(plan.label, ADHOC_BROWSER_LABEL);
  assert.equal(plan.source, ADHOC_BROWSER_SOURCE);
});
