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

/** The browser playbook prose (no leading separator / heading). The session
 *  drives the live browser DIRECTLY — no sub-agent delegation. Shared by the
 *  two delivery paths below: it normally rides a seeded CLAUDE.md in the task
 *  workspace (browserPlaybookMarkdown), and falls back to the prompt only when
 *  a session runs in a user's project folder where that CLAUDE.md can't load
 *  (playwrightPromptAddendum). One source of truth so the two never drift. */
function playbookBody(): string[] {
  const T = TOOLS_CLI; // tool repository CLI (absolute)
  const C = BROWSER_CLI; // raw driver CLI (absolute)
  return [
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
    'TIER ORDER (cheapest first — climb only when a tier can\'t do it):',
    '  API channel → deterministic tool → REPAIR → full agent.',
    '  A direct API/integration (when one exists) beats driving a browser; a',
    '  saved tool beats raw driving; REPAIRING a tool that almost worked beats',
    '  re-solving from scratch. The full-agent path (tier 4) is SLOW and the',
    '  EXPENSIVE LAST RESORT — reach it only for a genuinely novel page after',
    '  repair has failed. Most browser tasks should finish at tier 2 or 3.',
    '',
    'THE API SHORTCUT (the fastest click is the one you never make). Playwright\'s',
    '  biggest edge: read/replay the page\'s OWN XHR/fetch and SKIP the rendered',
    '  UI. Before clicking through a flow, ask: can the page\'s underlying request',
    '  do this directly? PREFER it when it can —',
    `    node ${C} net-observe [urlFilter] [--ms n]   watch the page\'s XHR/fetch;`,
    '       run it, then nudge the page, to learn WHICH request carries the data',
    '       (NON-PHI metadata only: method/url/status/content-type, never bodies).',
    `    node ${C} net-replay <url> [--method M] [--data s]   re-issue that request`,
    '       through the page\'s OWN signed-in context (no DOM, no re-auth) and read',
    '       the JSON back. A GET/HEAD replay is a safe read. A MUTATING method',
    '       (POST/PUT/…) is a SIDE EFFECT — same as clicking Submit — and is',
    '       REFUSED unless --allow-mutation, which you pass ONLY on an explicit,',
    '       human-confirmed submit. This is the ON-RAMP to the tier-1 API channel:',
    '       a discovered in-page API often becomes a standalone API tool. When you',
    '       solve a flow via a request, CAPTURE that request as the tool\'s fast',
    '       path (a net-replay step) so the next run never touches the DOM.',
    '    RECALL FIRST: before opening the browser at all, check the site\'s known',
    `       API. \`node ${T} api-spec recall <url>\` returns any recorded api-spec`,
    '       (NON-PHI, KEYS only: method, path, header/param KEY names, me.* auth',
    '       ref). If one exists, just net-replay/curl it — no rediscovery. You',
    `       usually don\'t even call it directly: \`node ${T} available <url>\``,
    '       AUTO-RECALLS and returns the domain\'s specs as `api_specs` with',
    '       `prefer_api:true` — a hit means net-replay it, skip the DOM. Recording',
    '       is automatic too: a SUCCESSFUL `net-replay` records the api-spec, and',
    '       promoting an API-only solve (`promote-from` → an `http`-channel tool)',
    `       records it alongside. To record by hand: \`node ${T} api-spec record`,
    '       --url <req-url> --method M [--header n]... [--param k]... [--auth me.key]\`',
    '       (KEYS only — a value-shaped token is REFUSED, never persisted). An',
    '       `http`-channel tool (see `available`/`help` `channel` field) means its',
    '       steps ARE the API call.',
    '',
    '1. REUSE a tool first (tier 2):',
    `  node ${T} available <url>     tools matching a URL (JSON)`,
    `  node ${T} help <tool-id>      a tool’s params + docs`,
    `  node ${T} run <tool-id> --p v run it (JSON {status,code,result,...})`,
    '  Exit codes: 0 ok · 1 fail · 2 bad output · 3 timeout(retry) · 4 auth ·',
    '  5 page-changed(UPDATE the tool) · 6 partial · 7 precondition · 8 stopped.',
    '',
    '2. REPAIR a failed tool (tier 3 — the DEFAULT next move on any non-zero,',
    '   NOT a jump to raw driving). On a non-zero exit, read the JSON result\'s',
    '   `error.likely_cause` (+ `error.message`/hint) and BRANCH on it:',
    '   • param        → re-run with corrected params (do NOT touch tool code).',
    '   • precondition → resolve the precondition (e.g. land/login first, enable',
    '                    the element), then re-run. Do NOT touch tool code.',
    '   • auth (exit 4)→ resolve creds / re-establish the session, then re-run.',
    '                    Do NOT touch tool code.',
    '   • selector_drift (exit 5, page-changed) → PATCH the tool: read the live',
    `                    page (\`node ${C} snapshot\`), fix the broken selector in`,
    `                    tool.mjs, \`node ${T} update <id> --script <f>\`, re-run.`,
    '   • timeout      → retry with backoff (the delay is external/transient).',
    '   • unknown      → escalate to tier 4 (the full-agent path below).',
    '   RESUME after a partial: on exit 6 the JSON carries `failed_step` +',
    '   `resume_from`. The break is AT one step; steps before it (including any',
    '   completed side-effect/submit) already succeeded. Fix that one step k —',
    '   patch its selector/params, or its code on selector_drift — then re-run',
    `   with \`node ${T} run <id> --resume-from <failed_step>\` so steps 1..k-1`,
    '   do NOT re-fire. A completed side-effect step is NEVER re-run: the runner',
    '   REFUSES a resume that would land at/before it (exit 7). `--dry-run`',
    '   prints the skip/plan offline before you commit. (docs/resumable-tool-steps.md)',
    '   Escalate to tier 4 ONLY after N failed repairs (default ~2) on the same',
    '   tool — repair is fast; full re-solve is not.',
    '',
    '3. FALLBACK — full agent: drive the page directly (tier 4, last resort —',
    '   only when no tool fits, or repair on an existing tool has been exhausted):',
    `  node ${C} <verb> [args]`,
    '  open [url] · goto <url> · snapshot [sel] · screenshot [path] · text [sel]',
    '  click <sel> · fill <sel> <v> · type <sel> <v> · press <key> · wait <sel>',
    '  eval <js> · url | title | pages · fill-ref <sel> <ref> · type-ref <sel> <ref>',
    '  net-observe [urlFilter] · net-replay <url> [--method M] (the API shortcut)',
    '  Loop: open/goto → snapshot → act → snapshot/screenshot to confirm. And',
    '  FIRST try net-observe/net-replay — a request that returns the data skips the',
    '  whole UI loop.',
    '  PROMOTION HOOK (concrete): after a full-agent solve of a REUSABLE flow, EMIT',
    '  a tool automatically instead of relying on memory — capture your successful',
    '  verb sequence (and/or the recorded flow) to a JSON file and run',
    `  \`node ${T} promote-from <id> --match <url> --actions <captured.json>\``,
    '  (or `--recording <recorded.json>`). It scaffolds a step-structured',
    '  status:candidate tool (KEYS/params only, never a value) that syncs to every',
    '  runner; after it passes a run or two it auto-promotes to active. This is how',
    '  novel pages graduate out of the slow path — pay for a page ONCE.',
    '',
    '5. LEARN (promotion) — when raw driving solves something REUSABLE, EMIT it as a',
    `  tool so it graduates to tier 2: \`breeze-tools promote-from <id> --match <url>`,
    '  --actions <f.json>\` (auto-scaffolds a candidate step tool; captures a',
    '  net-replay fast path when you found one), or hand-author with',
    '  `breeze-tools create <id> --from "$d"`; on exit 5 `update` it instead of',
    '  re-driving. 6. MEMORY — `breeze-tools memory get|add --site|--task`',
    '  for durable NON-PHI how-to (selectors, fast path), NEVER a value.',
    '  BOTH `--site` (by domain) and `--task` (by task tag) memory are SHARED',
    '  across machines + teammates (recall site memory with `memory get --site',
    '  <url>` after you land on a page, BEFORE re-deriving a selector). Capture',
    '  wins AND dead-ends. Delete a shared note with `--site <url> --id <note-id>`',
    '  (or `--task <tag> --id <note-id>`).',
    '',
    '7. PARAM BINDINGS (fill params instantly on a repeat run) — remember WHICH',
    `  task data KEY feeds WHICH tool param, keyed by (domain, task tag): \`node ${T}`,
    '  bindings recall --task <tag> --domain <url> [--tool <id>]\` BEFORE you reason',
    '  about params — if a binding exists, fill the param from that data KEY',
    '  directly (no re-deriving which key goes where). After a tool run SUCCEEDS,',
    `  record what you used: \`node ${T} bindings record --task <tag> --domain <url>`,
    '  --tool <id> --param <p> --data <key>\` (one --param/--data pair per param).',
    '  KEYS ONLY — record the placeholder key (e.g. data:patient.contact_email),',
    '  NEVER the resolved value; the binding is shared NON-PHI memory like the rest.',
    '',
    'SENSITIVE DATA: fill a KEY, never the real value. Customer/patient PHI comes',
    'from the task’s data placeholders (e.g. `patient.ssn`) — use `fill-ref`/',
    '`type-ref` with the KEY. The USER’s OWN identifiers (NPI, practice Tax ID,',
    'portal login id — never a password) use reserved `me.*` placeholders (e.g.',
    '`me.npi`, `me.tax_id`) via the same fill-ref path; do NOT ask the human for',
    'them. Never read back or screenshot a filled sensitive field. A real',
    'submission (send/pay/file) needs explicit human confirmation before you click.',
  ];
}

/** The playbook as a standalone CLAUDE.md document. Seeded into the app-owned
 *  task workspace (~/.breezefile/tasks/CLAUDE.md) so a task session auto-loads
 *  it from cwd — the injected prompt then carries only the task itself. */
export function browserPlaybookMarkdown(): string {
  return ['# Browser tasks', '', ...playbookBody(), ''].join('\n');
}

/** The playbook as a prompt addendum. Used ONLY as a fallback when a session
 *  runs in a user's project folder (not the workspace), where the seeded
 *  CLAUDE.md is out of scope and we won't write one into the user's repo. */
export function playwrightPromptAddendum(): string {
  return ['', '---', ...playbookBody()].join('\n');
}
