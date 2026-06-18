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

/** Root the automation helpers resolve against.
 *  - dev / tsc build: APP_ROOT is the repo root, so electron/browser/*.mjs and
 *    bin/*.mjs sit under it and `node` resolves playwright-core from the repo
 *    node_modules.
 *  - packaged: electron-builder ships the automation tree (bin/, electron/
 *    browser/ and a bundled playwright-core) under Resources/automation,
 *    preserving the relative layout so the .mjs imports (`../electron/browser`)
 *    and the playwright-core resolution both still hold. */
function automationRoot(): string {
  if (process.env.APP_ROOT && !/[\\/]app\.asar([\\/]|$)/.test(process.env.APP_ROOT)) {
    return process.env.APP_ROOT;
  }
  if (process.resourcesPath) return path.join(process.resourcesPath, 'automation');
  return process.env.APP_ROOT || process.cwd();
}

/** Absolute path to the raw browser-driver CLI (the fallback verbs). */
export const BROWSER_CLI = path.join(automationRoot(), 'electron', 'browser', 'cli.mjs');

/** Absolute path to the Tool Repository CLI (docs/Playwright agent.md). The
 *  agent consults this FIRST to reuse an existing tool, falling back to the
 *  raw BROWSER_CLI verbs only when no tool fits. */
export const TOOLS_CLI = path.join(automationRoot(), 'bin', 'breeze-tools.mjs');

/** Permission allow-rules a playwright session needs to run the helpers
 *  unattended. Paths are unquoted on purpose: claude matches Bash rules by
 *  command prefix, and the CLI paths have no spaces. */
export function browserCliAllowRules(): string[] {
  return [`Bash(node ${BROWSER_CLI}:*)`, `Bash(node ${TOOLS_CLI}:*)`];
}

/** Instructions appended to the agent's prompt when the `playwright` flag is
 *  set. Implements the docs/Playwright agent.md workflow: TRY TO REUSE an
 *  existing tool first (the tool repository), and fall back to raw DOM driving
 *  only when no tool fits. Your actions show live in the side-by-side window. */
export function playwrightPromptAddendum(): string {
  return [
    '',
    '---',
    'Browser automation (Playwright). You drive a live, side-by-side Breeze',
    'browser window. Everything is already installed: do NOT install Playwright,',
    'download browsers, write your own driver script, or use any',
    'claude-in-chrome tools. Two Bash helpers only.',
    '',
    '## 1. FIRST: try a reusable tool',
    '',
    'A tool repository holds vetted, parameterized automations. Always check it',
    'BEFORE writing custom steps — reuse is faster and more reliable.',
    '',
    `  node ${TOOLS_CLI} available <url>      tools that match a URL (JSON)`,
    `  node ${TOOLS_CLI} help <tool-id>       a tool's params + docs (JSON)`,
    `  node ${TOOLS_CLI} run <tool-id> --p v  run it`,
    `  node ${TOOLS_CLI} list                 every tool`,
    '',
    'Workflow: get the current `url` (below) → `available <url>` → if a tool',
    'fits, `help` it, then `run` it. `run` prints JSON {status, code, result,...}',
    'and exits with a code that tells you what happened:',
    '  0 success · 1 failure · 2 bad output · 3 timeout (retry) · 4 auth failed',
    '  5 page changed (tool needs updating) · 6 partial · 7 precondition unmet',
    'On 0, you are done — report result. On 4/7, fix the precondition (e.g. log',
    'in) and retry. On 1/2/5, fall back to step 2.',
    '',
    '## 2. FALLBACK: drive the page directly',
    '',
    'Only when no tool fits or a tool fails. Raw verbs:',
    '',
    `  node ${BROWSER_CLI} <verb> [args]`,
    '',
    '  open [url]            open/focus the browser window (creates it if none)',
    '  goto <url>            navigate the page',
    '  snapshot [selector]   ARIA tree of the page — your primary "eyes"',
    '  screenshot [path]     PNG of the page; then Read the file to SEE it',
    '  text [selector]       innerText (default body)',
    '  click <selector>      click first match',
    '  fill <selector> <v>   set an input value',
    '  type <selector> <v>   type into an element',
    '  fill-ref <sel> <ref>  fill from a task data placeholder (see below)',
    '  type-ref <sel> <ref>  type from a task data placeholder (see below)',
    '  press <key>           keyboard press (e.g. Enter)',
    '  wait <selector>       wait for a selector',
    '  eval <jsExpression>   evaluate JS in the page, prints JSON',
    '  url | title | pages   read state / list pages',
    '',
    'Selectors accept CSS, text= and xpath= engines. Workflow: `open` (or',
    '`goto`) → `snapshot` to read the page → act (click/fill/press) → `snapshot`',
    'or `screenshot` to confirm. When a step is ambiguous, `screenshot out.png`',
    'and Read the PNG to see the page visually before deciding.',
    '',
    'Sensitive data (PII): when the task lists data placeholders (keys like',
    '`patient.ssn`), DO NOT ask for or type the real values. Use `fill-ref`/',
    '`type-ref` with the KEY — Breeze resolves the real value privately and',
    'fills it. The value never passes through you. Never try to read a filled',
    'sensitive field back (eval/snapshot) or screenshot a filled form — that',
    'would expose the value you were given a placeholder to avoid.',
  ].join('\n');
}
