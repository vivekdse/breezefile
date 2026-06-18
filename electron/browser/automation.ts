// ─── SPIKE (spike/playwright-cdp): embedded-browser automation wiring ────────
//
// One place for the constants + prompt text + permission rules that let an
// in-app claude session drive Breeze's embedded browser tab over CDP, via the
// helper CLI in electron/browser/cli.mjs. Shared by the interactive launcher
// (electron/agents/interactive.ts) and the TypeBuild source
// (electron/sources/typebuild.ts) so the two run styles stay in sync.

import path from 'node:path';

/** CDP endpoint Breeze exposes (electron/main.ts --remote-debugging-port). */
export const CDP_URL = 'http://localhost:9222';

/** Absolute path to the helper CLI. APP_ROOT is the repo root in dev; the
 *  source .mjs lives there so the agent's `node` resolves playwright-core from
 *  the repo node_modules. (Packaging note: bundle electron/browser +
 *  playwright-core and repoint this before this leaves spike status.) */
export const BROWSER_CLI = path.join(
  process.env.APP_ROOT || process.cwd(),
  'electron',
  'browser',
  'cli.mjs',
);

/** Permission allow-rules a playwright session needs to run the helper
 *  unattended. The path is unquoted on purpose: claude matches Bash rules by
 *  command prefix, and the CLI path has no spaces. */
export function browserCliAllowRules(): string[] {
  return [`Bash(node ${BROWSER_CLI}:*)`];
}

/** Instructions appended to the agent's prompt when the `playwright` flag is
 *  set: how to drive the embedded Breeze browser tab via the helper CLI. */
export function playwrightPromptAddendum(): string {
  return [
    '',
    '---',
    'Browser automation (Playwright). Drive the side-by-side Breeze browser',
    'window by running this helper via Bash — your actions show live in that',
    'window. This is already installed: do NOT install Playwright, download',
    'browsers, write your own driver script, or use any claude-in-chrome tools.',
    'Use ONLY:',
    '',
    `  node ${BROWSER_CLI} <verb> [args]`,
    '',
    'Verbs:',
    '  open [url]            open/focus the browser window (creates it if none)',
    '  goto <url>            navigate the page',
    '  snapshot [selector]   ARIA tree of the page — your primary "eyes"',
    '  screenshot [path]     PNG of the page; then Read the file to SEE it',
    '  text [selector]       innerText (default body)',
    '  click <selector>      click first match',
    '  fill <selector> <v>   set an input value',
    '  type <selector> <v>   type into an element',
    '  press <key>           keyboard press (e.g. Enter)',
    '  wait <selector>       wait for a selector',
    '  eval <jsExpression>   evaluate JS in the page, prints JSON',
    '  url | title | pages   read state / list pages',
    '',
    'Selectors accept CSS, text= and xpath= engines. Workflow: `open` (or',
    '`goto`) → `snapshot` to read the page → act (click/fill/press) → `snapshot`',
    'or `screenshot` to confirm. When a step is ambiguous, `screenshot out.png`',
    'and Read the PNG to see the page visually before deciding.',
  ].join('\n');
}
