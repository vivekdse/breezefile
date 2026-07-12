// Shared app-owned task/browser workspace (extracted from electron/sources/
// typebuild.ts so BOTH the TypeBuild task launcher AND the task-less ad-hoc
// Ctrl+B browser session use the ONE workspace-seeding implementation rather
// than a hand-mirrored copy — see electron/agents/adhoc-browser.ts).
//
// Every interactive browser-driving session (a TypeBuild task OR the ad-hoc
// Ctrl+B pair) runs in this app-owned workspace rather than the user's home
// dir. A single, stable cwd gives us one place to seed (and let the user
// extend) the permission grant the session needs, and keeps sessions out of
// whatever folder happens to be focused. A session launched with cwd=TASKS_DIR
// auto-loads the seeded browser playbook (CLAUDE.md) from cwd, so the injected
// prompt carries only the task (or, for ad-hoc, nothing task-specific at all).

import path from 'node:path';
import { stateDir } from '../core/profile.mjs';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { browserCliAllowRules, browserPlaybookMarkdown } from '../browser/automation';

export const TASKS_DIR = path.join(stateDir(), 'tasks');
const TASKS_SETTINGS = path.join(TASKS_DIR, '.claude', 'settings.json');
// The browser playbook lives HERE as project memory rather than in the injected
// prompt: a session launched with cwd=TASKS_DIR auto-loads it, so the prompt we
// inject carries only the task. App-owned dir, so we (over)write-if-changed.
const TASKS_CLAUDE_MD = path.join(TASKS_DIR, 'CLAUDE.md');

// Tools an interactive browser session must call unattended:
//   mcp__typebuild        — the TypeBuild MCP server (task lifecycle verbs).
//                           Inert for the ad-hoc session (no typebuild MCP is
//                           configured for it) — harmless to pre-approve.
//   Bash(node <cli>:*)    — SPIKE (spike/playwright-cdp): the embedded-browser
//                           helper, the in-app replacement for claude-in-chrome
// Server-level rules (no __tool suffix) cover every current + future tool on
// each server, so the session never stalls on a per-tool permission prompt.
// browserCliAllowRules() is resolved at seed time (it embeds an absolute path).
const BASELINE_ALLOW = ['mcp__typebuild', ...browserCliAllowRules()];

// Ensure ~/.breezefile/tasks/.claude/settings.json exists and grants the
// baseline allow-rules, MERGING into any rules the user added rather than
// clobbering them. Returns the cwd + settings path for the launcher. We pass
// the settings file to claude explicitly via --settings so the grant applies
// regardless of whether the folder is "trusted".
export function ensureTasksWorkspace(): { cwd: string; settingsPath: string } {
  mkdirSync(path.dirname(TASKS_SETTINGS), { recursive: true });
  const existed = existsSync(TASKS_SETTINGS);
  let settings: Record<string, any> = {};
  if (existed) {
    try {
      settings = JSON.parse(readFileSync(TASKS_SETTINGS, 'utf8')) || {};
    } catch {
      // Corrupt/hand-edited file — start fresh rather than throwing on launch.
      settings = {};
    }
  }
  const perms = (settings.permissions ??= {});
  const allow: string[] = Array.isArray(perms.allow) ? perms.allow : [];
  let changed = !existed || !Array.isArray(perms.allow);
  for (const rule of BASELINE_ALLOW) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      changed = true;
    }
  }
  perms.allow = allow;
  if (changed) {
    writeFileSync(TASKS_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  }
  // Seed the browser playbook as workspace memory (auto-loaded from cwd). Write
  // only when content differs so we don't churn the file every launch.
  const playbook = browserPlaybookMarkdown();
  let playbookCurrent = '';
  try {
    playbookCurrent = readFileSync(TASKS_CLAUDE_MD, 'utf8');
  } catch {
    /* absent/unreadable — write it */
  }
  if (playbookCurrent !== playbook) {
    writeFileSync(TASKS_CLAUDE_MD, playbook);
  }
  return { cwd: TASKS_DIR, settingsPath: TASKS_SETTINGS };
}
