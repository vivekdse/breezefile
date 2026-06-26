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
 *  session drives the live browser DIRECTLY — no sub-agent delegation. The full
 *  playbook rides here so the session has it in its own context (the same prose
 *  also lives in ~/.breezefile/browser actions/CLAUDE.md for manual sessions). */
export function playwrightPromptAddendum(): string {
  const T = TOOLS_CLI; // tool repository CLI (absolute)
  const C = BROWSER_CLI; // raw driver CLI (absolute)
  return [
    '',
    '---',
    'Browser task. A live, side-by-side Breeze browser window is open over CDP —',
    'the user\'s REAL, signed-in session. Drive it YOURSELF; do NOT fetch pages',
    'out-of-band or use claude-in-chrome tools. Everything is installed: do not',
    'install Playwright, download browsers, or write your own driver. If the',
    'browser genuinely cannot do the task, say so — never silently route around it.',
    '',
    'Two Bash helpers only:',
    `  TOOLS:   node ${T} <cmd>`,
    `  DRIVER:  node ${C} <verb>`,
    `Task id is in $BREEZE_TYPEBUILD_TASK_ID when set.`,
    '',
    '1. REUSE a tool first:',
    `  node ${T} available <url>     tools matching a URL (JSON)`,
    `  node ${T} help <tool-id>      a tool’s params + docs`,
    `  node ${T} run <tool-id> --p v run it (JSON {status,code,result,...})`,
    '  Exit codes: 0 ok · 1 fail · 2 bad output · 3 timeout(retry) · 4 auth ·',
    '  5 page-changed(UPDATE the tool) · 6 partial · 7 precondition · 8 stopped.',
    '',
    '2. FALLBACK — drive the page directly (only when no tool fits):',
    `  node ${C} <verb> [args]`,
    '  open [url] · goto <url> · snapshot [sel] · screenshot [path] · text [sel]',
    '  click <sel> · fill <sel> <v> · type <sel> <v> · press <key> · wait <sel>',
    '  eval <js> · url | title | pages · fill-ref <sel> <ref> · type-ref <sel> <ref>',
    '  Loop: open/goto → snapshot → act → snapshot/screenshot to confirm.',
    '',
    '3. LEARN — when raw driving solves something REUSABLE, package it as a tool',
    '  (stage in a mktemp dir, then `breeze-tools create <id> --from "$d"`; on',
    '  exit 5 `update` it). 4. MEMORY — `breeze-tools memory get|add --site|--task`',
    '  for durable NON-PHI how-to (selectors, fast path), NEVER a value.',
    '',
    'SENSITIVE DATA: fill a KEY, never the real value. Customer/patient PHI comes',
    'from the task’s data placeholders (e.g. `patient.ssn`) — use `fill-ref`/',
    '`type-ref` with the KEY. The USER’s OWN identifiers (NPI, practice Tax ID,',
    'portal login id — never a password) use reserved `me.*` placeholders (e.g.',
    '`me.npi`, `me.tax_id`) via the same fill-ref path; do NOT ask the human for',
    'them. Never read back or screenshot a filled sensitive field. A real',
    'submission (send/pay/file) needs explicit human confirmation before you click.',
  ].join('\n');
}
