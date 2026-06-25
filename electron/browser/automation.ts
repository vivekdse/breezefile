// ─── SPIKE (spike/playwright-cdp): embedded-browser automation wiring ────────
//
// One place for the constants + prompt text + permission rules that let an
// in-app claude session drive Breeze's embedded browser tab over CDP, via the
// helper CLI in electron/browser/cli.mjs. Shared by the interactive launcher
// (electron/agents/interactive.ts) and the TypeBuild source
// (electron/sources/typebuild.ts) so the two run styles stay in sync.

import os from 'node:os';
import path from 'node:path';

/** CDP endpoint Breeze exposes (electron/main.ts --remote-debugging-port). */
export const CDP_URL = 'http://localhost:9222';

/** Stable, user-owned dir the automation helpers are INSTALLED into on launch
 *  (electron/browser/install-runtime.mjs copies them there + a bundled
 *  playwright-core). os.homedir()-based on purpose:
 *   - the path is correct regardless of WHEN this module evaluates — it no
 *     longer depends on process.env.APP_ROOT, which main.ts sets only AFTER
 *     this module is first imported (the old repo-relative consts resolved to a
 *     nonexistent node_modules/.../resources/automation and every helper failed
 *     with MODULE_NOT_FOUND);
 *   - it is identical in dev + packaged, and the user can inspect/edit it.
 *  Honors $BREEZE_AUTOMATION_DIR (kept in sync with install-runtime.mjs). */
function automationDir(): string {
  return (
    process.env.BREEZE_AUTOMATION_DIR ||
    path.join(os.homedir(), '.breezefile', 'automation')
  );
}

/** Absolute path to the raw browser-driver CLI (the fallback verbs). */
export const BROWSER_CLI = path.join(automationDir(), 'electron', 'browser', 'cli.mjs');

/** Absolute path to the Tool Repository CLI (docs/Playwright agent.md). The
 *  agent consults this FIRST to reuse an existing tool, falling back to the
 *  raw BROWSER_CLI verbs only when no tool fits. */
export const TOOLS_CLI = path.join(automationDir(), 'bin', 'breeze-tools.mjs');

/** Permission allow-rules a playwright session needs to run the helpers
 *  unattended. Paths are unquoted on purpose: claude matches Bash rules by
 *  command prefix, and the CLI paths have no spaces. */
export function browserCliAllowRules(): string[] {
  return [`Bash(node ${BROWSER_CLI}:*)`, `Bash(node ${TOOLS_CLI}:*)`];
}

/** Appended to a task session's prompt when the `playwright` flag is set. The
 *  full browser playbook lives in the `breeze-browser` subagent
 *  (electron/browser/subagent.ts, installed to ~/.claude/agents/) — here we just
 *  tell the task session to DELEGATE its browser work to it. */
export function playwrightPromptAddendum(): string {
  return [
    '',
    '---',
    'Browser task. A live, side-by-side Breeze browser window is open. Do NOT',
    'drive it yourself or fetch pages out-of-band — DELEGATE the browser work to',
    'the `breeze-browser` subagent (Agent tool, subagent_type: "breeze-browser").',
    'It holds the full playbook (reuse/build tools, site+task memory, fill-ref for',
    'PII) and operates the real signed-in browser over CDP.',
    '',
    'Give the subagent, in its prompt: the goal; the start URL; exactly what to',
    'extract or produce; any data-placeholder KEYS the task lists (the KEYS only —',
    'never their values); and the task id from $BREEZE_TYPEBUILD_TASK_ID if set.',
    'Note: `me.*` placeholders (e.g. `me.npi`, `me.taxId`) resolve to the USER\'s',
    'OWN saved credentials — NPI, practice Tax ID, portal login IDs — via the same',
    'fill-ref path, distinct from the per-task patient PHI; the subagent uses them',
    'when a form needs the provider\'s own identifier rather than customer data.',
    'When it returns its result, finish the task as usual (e.g. submit). If the',
    'subagent reports the browser cannot do something, surface that — do not work',
    'around it by fetching the page yourself.',
  ].join('\n');
}
