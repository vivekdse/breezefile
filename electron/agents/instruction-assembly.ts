// Server-populated workspace instructions (follow-on to task-7bc1f1dfc202).
//
// The workspace CLAUDE.md — the browser playbook every operator session
// auto-loads from cwd (Claude Code and Pi both read CLAUDE.md context files
// natively) — was seeded from a hardcoded string in the client
// (automation.ts playbookBody), so updating the single most critical
// instruction doc required a client release. This module makes the SERVER the
// source of truth: it fetches the `playbook` scope of the operator-instructions
// endpoint (same fetch + per-scope disk cache as the `global` doc) and rewrites
// the workspace CLAUDE.md from it, falling back to the bundled playbook when
// the server has no doc yet (version 0 / offline / scope not yet supported
// server-side — see the task_manager_api task filed alongside this change).
//
// MACHINE PORTABILITY: the bundled playbook embeds absolute helper-CLI paths,
// which must not live verbatim in a shared server doc. The server copy uses
// {{BREEZE_TOOLS_CLI}} / {{BREEZE_BROWSER_CLI}} placeholders; we substitute the
// machine's real paths at write time.
//
// LATENCY: refresh is FIRE-AND-FORGET from the launch paths — the current
// launch reads whatever CLAUDE.md is already on disk (bundled seed on first
// run, last synced copy after), and the fetched update lands for the NEXT
// launch. This keeps zero network latency on the spawn path; the global-doc
// addendum (fetched in the launch wave) still delivers same-launch dynamic
// guidance.
//
// NON-PHI: operator instructions are standing guidance; the server PHI-guards
// writes. Never log the body.

import { readFileSync, writeFileSync } from 'node:fs';
import { browserCliEnv } from '../browser/automation';
import { TASKS_CLAUDE_MD } from './tasks-workspace';

/** First-line marker identifying a server-derived workspace CLAUDE.md (the
 *  full line carries the doc version). ensureTasksWorkspace checks it before
 *  reseeding the bundled playbook. */
export const SERVER_PLAYBOOK_MARKER = '<!-- source: typebuild-playbook';

/** Substitute the server doc's machine-neutral placeholders with this
 *  machine's absolute helper paths. */
function substitutePlaceholders(body: string): string {
  const env = browserCliEnv();
  return body
    .replaceAll('{{BREEZE_TOOLS_CLI}}', env.BREEZE_TOOLS_CLI)
    .replaceAll('{{BREEZE_BROWSER_CLI}}', env.BREEZE_BROWSER_CLI);
}

/** Refresh the workspace CLAUDE.md from the server-hosted `playbook` doc.
 *  Best-effort and never throws; callers fire-and-forget it at launch. */
export async function refreshWorkspaceInstructions(): Promise<void> {
  try {
    const { fetchOperatorInstructions } = await import(
      '../typebuild/operator-instructions'
    );
    const doc = await fetchOperatorInstructions('playbook');
    const body = doc.body?.trim();
    if (!body) return; // nothing set server-side yet → keep the bundled seed
    // The marker tells ensureTasksWorkspace this file is server-derived so its
    // bundled-seed write-if-changed must NOT clobber it back every launch.
    const next =
      `${SERVER_PLAYBOOK_MARKER} v${doc.version ?? 0} -->\n` +
      substitutePlaceholders(body) +
      '\n';
    let current = '';
    try {
      current = readFileSync(TASKS_CLAUDE_MD, 'utf8');
    } catch {
      /* absent — write it */
    }
    if (current !== next) writeFileSync(TASKS_CLAUDE_MD, next);
  } catch {
    /* offline / unsupported scope — the bundled seed remains authoritative */
  }
}
