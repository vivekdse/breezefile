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
    'DO THE WORK IN THE BROWSER. This task runs through the live browser — do NOT',
    'substitute WebFetch, a separate HTTP request, or your own recall for driving',
    'the page, even when that looks faster. Two reasons: (1) it is the user’s',
    'REAL, signed-in session — only it reaches authenticated or JS-rendered',
    'content, and the result (e.g. a sent email) actually happens; (2) every page',
    'you drive is a chance to reuse or build a tool, which is how this system gets',
    'faster over time. Find speed by reusing a TOOL or a prefill-URL shortcut',
    'WITHIN the browser — never by bypassing it. If the browser genuinely cannot',
    'do the task, say so; do not silently route around it.',
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
    '## 3. LEARN: save what worked as a reusable tool',
    '',
    'When you solved something by raw driving and the pattern is REUSABLE (a',
    'login, an extraction, a form submit you may do again), package it so next',
    'time is one `run` call. A tool is a folder with two files:',
    '  - tool.json  — metadata: { id, name, description, match: ["<url-substr>"],',
    '      version, params?: { name: { required, type, description, secret? } } }',
    '  - tool.mjs   — `export async function run(ctx, params)` where',
    '      ctx = { page, browser, loc, log, EXIT, ToolError }. Return a value on',
    '      success; `throw new ctx.ToolError("selector_not_found", "...")` to fail',
    '      with a category. Use params for anything site-instance-specific; keep',
    '      selectors stable (prefer role/aria/text over brittle ids).',
    'Write those two files, then register:',
    `  node ${TOOLS_CLI} create <id> --meta <tool.json> --script <tool.mjs>`,
    `  node ${TOOLS_CLI} update <id> [--meta <f>] [--script <f>]   (fix/improve)`,
    `  node ${TOOLS_CLI} delete <id>                               (remove)`,
    'Then `run` it to confirm it works end-to-end before moving on. A tool that',
    'fails with exit 5 (page changed) is your cue to `update` it, not redo by hand.',
    '',
    '## Memory: durable NON-PHI notes (check first, record after)',
    '',
    'Persisted hints scoped by site (domain) or task. CHECK before you act and',
    'RECORD what you learned so you (or a teammate) move faster next time:',
    `  node ${TOOLS_CLI} memory get --site <url>      what we know about this site`,
    `  node ${TOOLS_CLI} memory add --site <url> "<note>"   e.g. selectors, layout`,
    `  node ${TOOLS_CLI} memory get|add --task <id>   per-task context/progress`,
    '(For a TypeBuild task, the id is in $BREEZE_TYPEBUILD_TASK_ID.) Memory is a',
    'SHARED, NON-PHI surface like skills: store HOW-TO ("headlines are <a> under',
    '.story-card"), NEVER a value (no patient data, no data-placeholder values, no',
    'credentials). Tools and memory are how this system learns — use them.',
    '',
    'Sensitive data (PII): when the task lists data placeholders (keys like',
    '`patient.ssn`), DO NOT ask for or type the real values. Use `fill-ref`/',
    '`type-ref` with the KEY — Breeze resolves the real value privately and',
    'fills it. The value never passes through you. Never try to read a filled',
    'sensitive field back (eval/snapshot) or screenshot a filled form — that',
    'would expose the value you were given a placeholder to avoid.',
  ].join('\n');
}
