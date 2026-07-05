// TypeBuildTaskSource (fm-b5at.4) — a remote TaskSource over the deployed
// TypeBuild REST API (general.typebuild.com /chromeext/*). Authenticates with
// a Firebase ID token (electron/typebuild/auth.ts) on every call.
//
// PHI invariant (non-negotiable, from the epic + typebuild CLAUDE.md):
// decrypted titles/bodies live in MAIN-PROCESS / RENDERER MEMORY ONLY. They
// never touch tasks.db, localStorage, logs, notifications, or the active-task
// sidecar. The capability `phiSensitive: true` gates those code paths off
// structurally elsewhere; here we simply never persist and never log task
// content (titles/bodies) or tokens.
//
// Shape of the work:
//   - listTasks: GET /chromeext/tasks?titles=1 (&all=1 when the filter wants
//     terminal states). The list carries routing fields + titles but no bodies
//     and no timestamps. We cache the last list IN MEMORY so getTask-by-id can
//     answer routing fields cheaply, and so the 30s poll can diff payloads.
//   - getTask: GET /chromeext/<id> returns the DECRYPTED detail; we map the
//     body into `notes` (what the detail UI renders) — memory only.
//   - sourceAction: claim/release/reopen via POST /chromeext/<id>/{claim,
//     release,reopen}. After each, refresh the cache and broadcast.
//   - runNow: stubbed (lands with fm-b5at.5).
//   - polling: every ~30s while registered; broadcast tasks-changed when the
//     payload differs; paused when there is no BrowserWindow.

import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { breezeHost } from '../core/host';
import type { TasksChangedDetail } from '../core/host';
import { classifyTransitions } from './typebuild-transitions.mjs';
import { diffSkeleton, deltaSkeleton, diffIsEmpty } from './task-skeleton-schema.mjs';
import type { SkeletonDiff } from './task-skeleton-schema.mjs';
import {
  loadLiveSkeleton,
  reconcile as reconcileSkeleton,
  applyDelta as applyDeltaSkeleton,
  getSyncCursor,
  setSyncCursor,
  patchSkeleton,
  loadProjects as loadProjectSkeleton,
  reconcileProjects,
  clearSkeleton,
  type SkeletonTask,
} from './task-skeleton-store';
import { getAuthState, getIdToken } from '../typebuild/auth';
import { mintMcpToken } from '../typebuild/mcp-token';
import { clearSession, registerSession } from '../typebuild/sessions';
// task-6fc9e503623e — the pure, unit-tested liveness classifier (shared .mjs).
// Keeping the runtime on the SAME helper the tests assert means the exit-code
// tagged error + recorded note can never drift from the tested contract.
import { classifyLiveness } from '../../src/components/tasks/startOutcome.mjs';
import {
  browserCliAllowRules,
  browserPlaybookMarkdown,
  playwrightPromptAddendum,
} from '../browser/automation';
import type {
  RunNowOptions,
  SourcedTask,
  TaskSource,
  TaskSourceCapabilities,
} from '../core/task-source';
import { unsupported } from '../core/task-source';
import type { Task, TaskCreate, TaskFilter, TaskStatus, TaskUpdate } from '../tasks';

const API_BASE = 'https://general.typebuild.com';
const POLL_INTERVAL_MS = 30_000;

// task-b1fe80e2669b (Phase 2) — delta-sync safety net. Most polls are cheap
// delta pulls (?updated_since=<cursor>), but a missed tombstone (e.g. a delta
// response we failed to persist) would otherwise linger forever. So every
// FULL_RECONCILE_EVERY-th poll we do a FULL pull instead, converging the
// skeleton + cache on server truth. At a 30s cadence, 10 polls ≈ a full
// reconcile every ~5 minutes — cheap insurance against drift.
const FULL_RECONCILE_EVERY = 10;

// Lazy Electron `BrowserWindow` accessor. The GUI methods (runNow,
// relaunchSession, onSessionExit, poll) broadcast to windows; the daemon never
// calls them (it only uses claimNext + the REST verbs). Requiring electron
// lazily keeps this module Electron-free AT LOAD so breezed can construct the
// source and call claimNext() without pulling a hard `electron` dependency into
// its bundle. Returns [] when electron isn't present (headless).
function browserWindows(): Array<{
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      BrowserWindow?: { getAllWindows(): unknown[] };
    };
    const all = electron.BrowserWindow?.getAllWindows() ?? [];
    return all as Array<{
      isDestroyed(): boolean;
      webContents: { send(channel: string, payload: unknown): void };
    }>;
  } catch {
    return [];
  }
}

// Env var the minted MCP token is injected under (PTY env only — never argv:
// /proc/<pid>/cmdline is world-readable). The inline --mcp-config below
// references it as ${TYPEBUILD_MCP_TOKEN}; claude expands it from the spawned
// process env (verified empirically — the inline JSON form expands the same as
// .mcp.json), so the literal token never appears on the command line.
const MCP_TOKEN_ENV = 'TYPEBUILD_MCP_TOKEN';

// Inline MCP config passed via `--mcp-config <string>`. It carries the ${VAR}
// REFERENCE, not the secret, so it is argv-safe. Paired with
// --strict-mcp-config so ONLY this server is loaded — sidestepping a name
// collision with the typebuild plugin's header-free .mcp.json while the
// plugin's skills/hooks still load.
const MCP_INLINE_CONFIG = JSON.stringify({
  mcpServers: {
    typebuild: {
      type: 'http',
      url: 'https://general.typebuild.com/mcp',
      headers: {
        Authorization: `Bearer \${${MCP_TOKEN_ENV}}`,
      },
    },
  },
});

// Every interactive TypeBuild session runs in this app-owned workspace rather
// than the user's home dir. A single, stable cwd gives us one place to seed
// (and let the user extend) the permission grant the session needs, and keeps
// task sessions out of whatever folder happens to be focused.
const TASKS_DIR = path.join(os.homedir(), '.breezefile', 'tasks');
const TASKS_SETTINGS = path.join(TASKS_DIR, '.claude', 'settings.json');
// The browser playbook lives HERE as project memory rather than in the injected
// prompt: a session launched with cwd=TASKS_DIR auto-loads it, so the prompt we
// inject carries only the task. App-owned dir, so we (over)write-if-changed.
const TASKS_CLAUDE_MD = path.join(TASKS_DIR, 'CLAUDE.md');

// Tools the /work flow must call unattended:
//   mcp__typebuild        — the TypeBuild MCP server (task lifecycle verbs)
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
function ensureTasksWorkspace(): { cwd: string; settingsPath: string } {
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

const capabilities: TaskSourceCapabilities = {
  canSchedule: false,
  canClaim: true,
  // fm-j7w0 (S4) — assignment + priority edits route through the generic
  // PATCH 'patch' verb (sourceAction), NOT the local-style updateTask path,
  // so canEdit stays false (the manual status-chip/title editors don't apply
  // to a remote PHI task).
  canEdit: false,
  // fm-iwlc (S6) — DELETE /chromeext/{id} is live (creator-only; 403 not_owner,
  // 409 in_progress_elsewhere). Light up the kebab/detail Delete affordances.
  canDelete: true,
  // fm-r8vj (S5 plumbing) — POST /chromeext/tasks creates a TypeBuild task.
  canCreate: true,
  phiSensitive: true,
  hasFolder: false,
};

// ─── Server payload shapes ───────────────────────────────────────────────
// Only the fields we consume are typed; the server may carry more.

/** A row from GET /chromeext/tasks?titles=1. Carries routing fields + title,
 *  but NO body and NO timestamps. */
type ListRow = {
  id: string;
  status?: string;
  raw_status?: string;
  blocked?: boolean;
  priority?: number;
  attempts?: number;
  max_attempts?: number;
  claimed_by?: string | null;
  group_id?: string | null;
  assigned_to?: string | null;
  start_url?: string | null;
  flags?: string[] | null;
  title?: string;
  url?: string | null;
  // fm-lji6 (S2) — v2 list+detail fields. `due_at` is an ISO timestamp;
  // `defer_until` an ISO timestamp; `parent_task_id` an opaque (non-PHI) id.
  due_at?: string | null;
  defer_until?: string | null;
  parent_task_id?: string | null;
  // task-ab1d7955e23f — owning project container (opaque, non-PHI).
  project_id?: string | null;
  // task-b8fa34a80a34 — the template this task was instantiated from (opaque,
  // NON-PHI id). FORWARD-COMPATIBLE: the server does not emit this yet — typed
  // OPTIONAL so IF/when the list (or detail) endpoint carries `template_id`, it
  // flows through mapListRow to the client's Task.templateId and the New Home
  // roster upgrades from (name,project) grouping to exact template grouping.
  template_id?: string | null;
  // task-896f3f7f5e75 — assigned AGENT (scalar; server `agent_id`). Opaque,
  // NON-PHI id; null/absent when unassigned. Typed on ListRow so IF the list
  // endpoint carries it, it flows to LIST rows too; the detail endpoint also
  // carries a resolved `agent` block (typed on DetailRow below).
  agent_id?: string | null;
  // task-b1fe80e2669b (Phase 2) — the list now emits REAL server timestamps
  // (ISO-'Z', lexically sortable; `updated_at` bumps on every mutation). NON-PHI.
  // Optional so a server that predates them still maps (mapListRow falls back to
  // the Date.now() floor). These replace the Phase-1 now()-placeholder.
  created_at?: string | null;
  updated_at?: string | null;
  // task-91d13f9d5469 — a PENDING QUESTION the task is blocked on (set by
  // `ask_user`, cleared by `answer_question`). VERIFIED on the detail endpoint
  // (get_task); typed here on ListRow too so that IF the list endpoint carries
  // it, it flows to LIST rows (attention classification runs over the list). A
  // server that omits it on the list simply leaves it undefined → the row has no
  // `asked` bucket until its detail is fetched. `text` is PHI (encrypted at
  // rest); memory-only client-side. `options`/`asked_by`/`asked_at` are non-PHI.
  pending_question?: {
    text?: unknown;
    options?: unknown;
    asked_by?: unknown;
    asked_at?: unknown;
  } | null;
};

/** Decrypted detail from GET /chromeext/<id>. `task` is the body (PHI). */
type DetailRow = ListRow & {
  task?: string | null; // decrypted body
  notes?: string | null;
  claimed_at?: string | number | null;
  // task-b8306d2b85c2 — lifecycle timestamps the timeline UI consumes. Typed
  // OPTIONAL: the server may not return them yet on the detail endpoint, in
  // which case the timeline derives Created from the audit trail rather than
  // faking it. NON-PHI (timestamps + an email principal).
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;
  skills?: unknown;
  // fm-lji6 (S2) — detail-only dependency fields. Memory-only; ids are
  // opaque (non-PHI) so they're safe to carry, but never persisted/logged.
  depends_on?: string[] | null;
  deps_satisfied?: boolean | null;
  blocked_by?: string[] | null;
  // task-19ba9f7f43f1 — a STRUCTURED, type-dispatched task result the client
  // renders bespoke (a `table` first). Present only once the server half ships
  // (submit_task_result); typed OPTIONAL so a server that predates it still maps
  // and the client falls back to notes. PHI: `payload` is task OUTPUT — carried
  // in memory only (never persisted to the skeleton store, which has no such
  // column), same rule as the decrypted body.
  result?: { type?: unknown; payload?: unknown } | null;
  // task-da23979fd907 — the USER-facing status channel: an append-only feed the
  // getTask path now surfaces ([{ text, by, at }], decrypted, in order). Typed
  // OPTIONAL/loose (a server that predates it simply omits it). PHI: `text` is
  // decrypted patient-visible content, carried in memory only (never persisted
  // to the skeleton store, which has no such column), same rule as `task`/
  // `result`. `by`+`at` are NON-PHI (email principal + ISO timestamp).
  messages?: unknown;
  // task-896f3f7f5e75 — the RESOLVED agent block get_task inlines alongside the
  // scalar `agent_id` (the agent's details: id + name + optional group +
  // advisory tools + launch_mode). NON-PHI (an agent identity, not patient
  // data). Typed loose/optional (a server that predates it simply omits it);
  // mapped defensively via mapResolvedAgent so a malformed block is dropped and
  // the detail line is simply omitted (NON-REGRESSION).
  agent?: unknown;
  // task-ce4b4c8ca955 — the server's first-class OUTPUT FIELD SCHEMA (S2): a
  // flat array of TaskDefField-shaped entries ({key,label,type,options?,
  // required?}), the same shape the client's own ```task-outputs block
  // carries (parseTaskOutputsBlock/TaskDefField, src/components/newhome/
  // types.ts) but declared server-side instead of parsed out of the body —
  // this is what lets a PLAIN (non-chained) task still declare required
  // outputs. NON-PHI: field DEFINITIONS only (keys/labels/types/options), NEVER
  // values — values ride `result.payload` as always. Typed loose/optional (a
  // server that predates it simply omits it); mapped defensively via
  // mapOutputSchema so a malformed entry is dropped rather than rejecting the
  // whole array (NON-REGRESSION).
  output_schema?: unknown;
  // task-4a8d2c98f667 — the drawer's Inputs section: NON-PHI key names for
  // this task's `data` bag (docs/typebuild-data-field-contract.md §4). Typed
  // loose/optional: a server that predates this simply omits it, and the
  // client falls back to session-known keys (see mapDetail's dataKeys below
  // and TaskDataInputs.tsx). NEVER carries values — only key strings.
  data_keys?: unknown;
};

// ─── Projects (task-ab1d7955e23f) ─────────────────────────────────────────
// A TypeBuild Project: a named container with optional instructions + a set of
// owned folders. NON-PHI (name/description/instructions/folders are not patient
// data) — but we still never log request bodies. Snake_case server JSON below;
// the client-facing `Project` is camelCase (mapped via mapProjectRow).
type ProjectRow = {
  id: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  parent_project_id?: string | null;
  folders?: string[] | null;
  created_by?: string | null;
  group_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  effective_instructions?: string | null;
  archived?: boolean | null;
};

/** A TypeBuild Project as the renderer sees it (camelCase). `effectiveInstructions`
 *  is present only when fetched with `effective=1` (or on create). NON-PHI. */
export type Project = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  parentProjectId: string | null;
  folders: string[];
  createdBy: string | null;
  groupId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  effectiveInstructions?: string;
  /** task-2c5448be520a — archived projects are hidden from the list by default
   *  (the server omits them unless asked). NON-PHI routing flag. */
  archived?: boolean;
};

// ─── Agents (task-896f3f7f5e75) ───────────────────────────────────────────
// A TypeBuild AGENT registry entry: id, name, optional `group` (group-OPTIONAL
// — private agents are allowed → `group` may be absent), a free-form advisory
// `tools` list (deduped server-side; display only, no validation), and a
// `launch_mode` (chrome/auto/resume/manual). NON-PHI: the server rejects a PHI
// agent name (422), so a name can never carry patient data — but we still never
// log request/response bodies. Snake_case-ish server JSON below; the
// client-facing `Agent` is camelCase (mapped via mapAgentRow).
type AgentRow = {
  id?: string;
  name?: string;
  group?: string | null;
  tools?: unknown;
  launch_mode?: string | null;
};

/** A TypeBuild Agent as the renderer sees it (camelCase). NON-PHI. `group` is
 *  null for a private agent; `tools` is advisory/display-only; `launchMode` is
 *  one of chrome/auto/resume/manual (or any string the server sends). */
export type Agent = {
  id: string;
  name: string;
  group: string | null;
  tools: string[];
  launchMode: string;
};

// Map a raw server agent row → the camelCase client `Agent`. Defensive (mirrors
// mapResult/mapMessages' "pass through ONLY when well-shaped" rule): a
// non-object or a row missing an id/name yields null, so a malformed entry is
// dropped rather than reaching the picker. `group` optional → null; `tools`
// coerced to string[] (non-array → []); `launchMode` passes through verbatim.
function mapAgentRow(raw: AgentRow | null | undefined): Agent | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!id || !name) return null;
  const group =
    typeof raw.group === 'string' && raw.group !== '' ? raw.group : null;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((t): t is string => typeof t === 'string')
    : [];
  const launchMode = typeof raw.launch_mode === 'string' ? raw.launch_mode : '';
  return { id, name, group, tools, launchMode };
}

// The RESOLVED agent block inlined on get_task (detail.agent). Same shape + the
// same defensive mapping as a listed agent; null (dropped) when absent/malformed
// so a task with no/malformed agent maps exactly as today (NON-REGRESSION).
function mapResolvedAgent(raw: unknown): Agent | null {
  return mapAgentRow(raw as AgentRow | null | undefined);
}

// ─── Group members (task-fd1be6f6b22d) ───────────────────────────────────
// The HUMAN principals the composer's "Who runs this?" picker offers (alongside
// Claude Code) — every active member across the caller's groups, plus self.
// NON-PHI: user identities (email/principal + optional display name/role), not
// patient data. Two possible server shapes, handled by listGroupMembers below.
type GroupMemberRow = {
  principal?: string;
  role?: string | null;
  display_name?: string | null;
  status?: string;
};
/** A group member as the renderer sees it (camelCase). NON-PHI. */
export type GroupMember = {
  principal: string;
  displayName: string | null;
  role: string | null;
};
// Dedupe by principal + map to the client shape. Defensive (mirrors
// mapAgentRow): rows without a principal are dropped; blank display_name/role
// collapse to null.
function dedupeMembers(rows: GroupMemberRow[]): GroupMember[] {
  const seen = new Set<string>();
  const out: GroupMember[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const principal = typeof r.principal === 'string' ? r.principal.trim() : '';
    if (!principal || seen.has(principal)) continue;
    seen.add(principal);
    out.push({
      principal,
      displayName:
        typeof r.display_name === 'string' && r.display_name.trim()
          ? r.display_name.trim()
          : null,
      role: typeof r.role === 'string' && r.role ? r.role : null,
    });
  }
  return out;
}

// ─── Templates (task-e112d60a3b7c) ────────────────────────────────────────
// A first-class TypeBuild TEMPLATE (server /chromeext/templates): a named,
// reusable job definition carrying INPUT `variables` (the human fills these at
// instantiate time) + an `output_schema` (copied onto the created task), plus
// inherited project/agent/flags. The list response is NON-PHI (names + field
// DEFINITIONS only — never values, never the `notes` prompt body); the detail
// (GET /chromeext/templates/{id}) additionally decrypts `notes` (PHI). Both
// `variables` and `output_schema` are the same flat TaskDefField shape the rest
// of the client uses (see OutputSchemaField above / TaskDefField, src/components/
// newhome/types.ts) — we reuse OutputSchemaField + mapOutputSchema rather than
// redefining a parallel field shape.
type TemplateRow = {
  id?: string;
  name?: string;
  project_id?: string | null;
  variables?: unknown;
  output_schema?: unknown;
  agent_id?: string | null;
  flags?: string[] | null;
  created_by?: string | null;
  group_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // detail-only (GET /chromeext/templates/{id}) — the decrypted prompt body.
  notes?: string | null;
};

/** A TypeBuild Template as the renderer sees it (camelCase). NON-PHI except
 *  `notes` (the decrypted prompt body, present only on the detail fetch —
 *  memory-only, never persisted/logged). `variables`/`outputSchema` carry field
 *  DEFINITIONS only (key/label/type/options/required), never values. */
export type Template = {
  id: string;
  name: string;
  projectId: string | null;
  variables: OutputSchemaField[];
  outputSchema: OutputSchemaField[];
  agentId?: string | null;
  flags?: string[];
  createdBy?: string | null;
  groupId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Decrypted prompt body — detail fetch only. PHI: memory-only. */
  notes?: string | null;
};

// ─── Status mapping ──────────────────────────────────────────────────────
// Map the server's status into the local TaskStatus enum. `rawStatus` ALWAYS
// carries the server's raw status so the UI badge shows failed/partial/blocked
// truthfully even when the mapped status collapses them into 'pending'.
//
//   server raw status   →  mapped TaskStatus
//   ─────────────────────  ─────────────────
//   open                →  pending
//   in_progress         →  in_progress
//   done                →  done
//   partial             →  done
//   cancelled           →  cancelled (fm-alfz/S1 — real terminal status now;
//                          previously collapsed to pending and sat in FOR
//                          AGENTS with a Start button)
//   failed              →  pending   (rawStatus shows 'failed')
//   blocked             →  pending   (rawStatus shows 'blocked')
//   <anything else>     →  pending
function mapStatus(raw: string | undefined): TaskStatus {
  switch (raw) {
    case 'in_progress':
      return 'in_progress';
    case 'done':
    case 'partial':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'open':
    case 'failed':
    case 'blocked':
    default:
      return 'pending';
  }
}

/** The raw status the badge should reflect. Prefer the explicit `raw_status`;
 *  fall back to `status`; treat a `blocked` flag as 'blocked'. */
function rawStatusOf(row: ListRow): string {
  if (row.blocked) return 'blocked';
  return row.raw_status ?? row.status ?? 'open';
}

// fm-lji6 (S2) — normalize a server ISO timestamp to the local 'YYYY-MM-DD'
// date part. Local rows store dates day-only; the due-date pill renders from
// that shape, so we trim the time to keep both legs identical. Returns null
// for nullish/empty input.
function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // 'YYYY-MM-DDTHH:MM:SSZ' or 'YYYY-MM-DD' → 'YYYY-MM-DD'. Cheap slice on the
  // ISO 8601 'T' separator; pass through anything already day-only.
  const t = iso.indexOf('T');
  return t > 0 ? iso.slice(0, t) : iso.slice(0, 10);
}

// task-b8306d2b85c2 — normalize a claimed_at that may arrive as an ISO string
// or an epoch (seconds or ms) into a single ISO string the UI can parse. NON-
// PHI (a timestamp). Returns null for nullish/empty/unparseable input.
function toIso(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    // Heuristic: < 1e12 is seconds (server epochs are seconds), else ms.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Already a string — trust it as ISO (the server emits ISO 8601). Validate
  // cheaply so a garbage value doesn't reach the UI.
  return Number.isNaN(Date.parse(v)) ? null : v;
}

// task-b1fe80e2669b (Phase 2) — parse a server ISO timestamp to epoch ms, or
// null when absent/garbage. The list now emits real created_at/updated_at, so
// we no longer have to now()-stamp every row. NON-PHI.
function isoToMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// task-19ba9f7f43f1 — normalize a wire `result` into the client's structured
// { type: string; payload: unknown } shape, or undefined when it's absent or
// malformed (so the client falls back to the plain notes view). We keep the
// dispatch OPEN — any string `type` is passed through; the renderer registry
// decides whether it knows how to render it (unknown types fall back too). The
// payload is task OUTPUT (potentially PHI) and rides in memory only.
function mapResult(
  r: { type?: unknown; payload?: unknown } | null | undefined,
): { type: string; payload: unknown } | undefined {
  if (!r || typeof r !== 'object') return undefined;
  if (typeof r.type !== 'string' || !r.type) return undefined;
  return { type: r.type, payload: r.payload ?? null };
}

// task-ce4b4c8ca955 — the field-def shape output_schema entries must match
// (mirrors TaskDefField, src/components/newhome/types.ts, and
// parseTaskOutputsBlock's isTaskDefFieldLike, src/components/newhome/
// taskSchema.mjs — keep the three in sync). NON-PHI: definitions only.
type OutputSchemaField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'bool';
  options?: string[];
  required?: boolean;
};

const OUTPUT_FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'bool']);

function isOutputSchemaFieldLike(v: unknown): v is OutputSchemaField {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  if (typeof f.key !== 'string' || !f.key) return false;
  if (typeof f.label !== 'string' || !f.label) return false;
  if (typeof f.type !== 'string' || !OUTPUT_FIELD_TYPES.has(f.type)) return false;
  if (f.options !== undefined && !Array.isArray(f.options)) return false;
  if (f.required !== undefined && typeof f.required !== 'boolean') return false;
  return true;
}

// task-ce4b4c8ca955 — map the server's `output_schema` (a flat array of
// TaskDefField-shaped entries — see the DetailRow.output_schema comment) into
// the client's SourcedTask.outputSchema. Defensive: drop malformed entries
// rather than rejecting the whole array (same fail-soft convention as
// mapMessages/mapPendingQuestion); absent/empty/malformed → undefined so a
// task with no server schema renders exactly as today (NON-REGRESSION).
// NON-PHI: field DEFINITIONS only (key/label/type/options/required) — never
// values, which ride `result.payload` as always.
function mapOutputSchema(raw: unknown): OutputSchemaField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(isOutputSchemaFieldLike);
  return out.length ? out : undefined;
}

// task-4a8d2c98f667 — normalize the wire `data_keys` into string[] | undefined.
// NON-PHI: key NAMES only, never values. Defensive: a non-array or an array
// of non-strings drops to undefined/filters out the bad entries rather than
// rejecting the whole task, matching mapOutputSchema's fail-soft rule.
function mapDataKeys(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((k): k is string => typeof k === 'string' && k.length > 0);
  return out.length ? out : undefined;
}

// task-da23979fd907 — normalize the wire `messages` value into the client's
// { text, by, at }[] shape, or undefined when it's absent/empty/malformed (so
// the client renders NOTHING and a message-less task looks exactly like today).
// Defensive + ORDER-PRESERVING (the server returns newest-last; we don't
// re-sort). Entries without usable `text` are dropped; `by`/`at` degrade to ''.
// `text` is DECRYPTED PHI and, like `notes`/`result`, rides in memory only — the
// skeleton store has no messages column, so it can never reach disk here.
function mapMessages(
  messages: unknown,
): { text: string; by: string; at: string }[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const out: { text: string; by: string; at: string }[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as { text?: unknown; by?: unknown; at?: unknown };
    const text = typeof rec.text === 'string' ? rec.text : '';
    if (!text) continue;
    const by = typeof rec.by === 'string' ? rec.by : '';
    const at = typeof rec.at === 'string' ? rec.at : '';
    out.push({ text, by, at });
  }
  return out.length ? out : undefined;
}

// task-91d13f9d5469 — normalize the wire `pending_question` into the client's
// { text, options?, asked_by?, asked_at? } shape, or undefined when it's
// absent/null/malformed (so a task with no open question renders exactly as
// today — NON-REGRESSION). Defensive: a question with no usable `text` is
// dropped (nothing to show/answer). `options` is kept only when it's a
// non-empty array of strings; `asked_by`/`asked_at` degrade to omitted. `text`
// is DECRYPTED PHI and, like `notes`/`messages`, rides in memory only — the
// skeleton store has no pending_question column, so it can never reach disk.
function mapPendingQuestion(
  q: unknown,
): { text: string; options?: string[]; asked_by?: string; asked_at?: string } | undefined {
  if (!q || typeof q !== 'object') return undefined;
  const rec = q as {
    text?: unknown;
    options?: unknown;
    asked_by?: unknown;
    asked_at?: unknown;
  };
  const text = typeof rec.text === 'string' ? rec.text : '';
  if (!text) return undefined;
  const out: {
    text: string;
    options?: string[];
    asked_by?: string;
    asked_at?: string;
  } = { text };
  if (Array.isArray(rec.options)) {
    const opts = rec.options.filter((o): o is string => typeof o === 'string');
    if (opts.length) out.options = opts;
  }
  if (typeof rec.asked_by === 'string' && rec.asked_by) out.asked_by = rec.asked_by;
  if (typeof rec.asked_at === 'string' && rec.asked_at) out.asked_at = rec.asked_at;
  return out;
}

function mapListRow(row: ListRow): SourcedTask {
  const raw = rawStatusOf(row);
  // task-b1fe80e2669b (Phase 2) — the list endpoint now carries REAL server
  // created_at/updated_at (ISO-'Z'). Use them. When the server omits them (an
  // older deployment), fall back to `now` as the Phase-1 benign placeholder so
  // the renderer's sorts/filters don't choke. This swap is STRICTLY BETTER for
  // the attention floor (src/projects/attention.mjs): a real past `updated_at`
  // is < the page-mount floor → counts as known activity (sawRealActivity),
  // whereas the old now()-stamp was AT the floor → treated as unknown. A
  // non-terminal row therefore no longer looks artificially "fresh" — it reads
  // its true last-touch time. completed_at is still null unless terminal.
  const now = Date.now();
  const createdMs = isoToMs(row.created_at);
  const updatedMs = isoToMs(row.updated_at);
  const status = mapStatus(row.status ?? row.raw_status);
  return {
    id: row.id,
    title: row.title ?? row.id,
    // NOTE: the list has no body; leave notes undefined. getTask fills it.
    notes: null,
    status,
    // hasFolder is false for this source — no folder across the seam.
    folder: undefined,
    start_at: null,
    // fm-lji6 (S2) — server `due_at` (ISO) → the EXISTING Task.due_at field,
    // normalized to the local day-only shape so the row's due pill + overdue
    // tinting work identically to local tasks.
    due_at: dateOnly(row.due_at),
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: false,
    auto_agent: null,
    auto_prompt: null,
    created_at: createdMs ?? now,
    // fm-alfz (S1) — terminal rows (done | cancelled) get a completed_at so
    // they sort sensibly in the DONE section (completed_at desc); non-terminal
    // rows leave it null. Phase 2: prefer the real updated_at for terminal rows
    // (the moment of completion), falling back to now() only if absent.
    updated_at: updatedMs ?? now,
    completed_at:
      status === 'done' || status === 'cancelled' ? (updatedMs ?? now) : null,
    // task-b1fe80e2669b (Phase 2) — persist the raw ISO stamps (non-PHI) so a
    // cold start renders the timeline without a detail round-trip, exactly like
    // the detail path. createdAtIso/updatedAtIso mirror the numeric epochs.
    createdAtIso: row.created_at ?? null,
    updatedAtIso: row.updated_at ?? null,
    // Source-specific fields.
    source: 'typebuild',
    rawStatus: raw,
    priority: typeof row.priority === 'number' ? row.priority : undefined,
    claimedBy: row.claimed_by ?? null,
    // fm-j7w0 (S4) — assignee (server `assigned_to`). Received-but-unmapped
    // until now; the detail panel renders it + edits it via PATCH. Non-PHI.
    assignedTo: row.assigned_to ?? null,
    attempts: typeof row.attempts === 'number' ? row.attempts : undefined,
    maxAttempts:
      typeof row.max_attempts === 'number' ? row.max_attempts : undefined,
    // Local Task.flags is a required string[] (fm-b5at.7); default to [].
    flags: Array.isArray(row.flags) ? row.flags : [],
    // fm-lji6 (S2) — v2 fields. deferUntil keeps its full ISO (the snooze pill
    // needs the time to decide "in the future"); parentTaskId is opaque.
    deferUntil: row.defer_until ?? null,
    parentTaskId: row.parent_task_id ?? null,
    // task-ab1d7955e23f — owning project container (opaque, non-PHI).
    projectId: row.project_id ?? null,
    // task-b8fa34a80a34 — template this task was instantiated from (opaque,
    // non-PHI). DEFENSIVE / forward-compatible: the server does not emit
    // `template_id` today, so this is undefined for now and the roster falls
    // back to (name,project) grouping; it upgrades to exact template grouping
    // the moment the field appears, with no other change. Absent → undefined
    // (not null) so a row without it is indistinguishable from today.
    templateId: typeof row.template_id === 'string' ? row.template_id : undefined,
    // task-896f3f7f5e75 — assigned AGENT (scalar; opaque, non-PHI id). Passed
    // through when the row carries it (the list MAY, the detail DOES); absent →
    // null so an unassigned task maps exactly as today (NON-REGRESSION). The
    // RESOLVED agent block rides on the detail path only (added in mapDetail).
    agentId: row.agent_id ?? null,
    // task-91d13f9d5469 — a PENDING QUESTION the task waits on (get_task
    // surfaces it; the list MAY too). Passed through ONLY when it's a well-shaped
    // { text, ... } object; absent/null/malformed → undefined so a question-less
    // row renders exactly as today (NON-REGRESSION) and the `asked` attention
    // bucket stays empty. `text` is DECRYPTED PHI carried in memory only — the
    // skeleton store has no pending_question column, so it never reaches disk.
    pending_question: mapPendingQuestion(row.pending_question),
  };
}

// A short, content-free fragment of an opaque task id for generic labels
// ("TypeBuild task a1b2c3"). The id is not PHI; this just keeps labels tidy.
function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

// ─── Source implementation ───────────────────────────────────────────────

export class TypeBuildTaskSource implements TaskSource {
  readonly id = 'typebuild';
  readonly label = 'TypeBuild';
  readonly capabilities = capabilities;

  // In-memory cache of the last list payload, by id. PHI-light: titles only,
  // no bodies. Memory only — never persisted. Cleared when the source is
  // unregistered (sign-out drops the whole instance).
  //
  // task-b3fb2928bb3c (Phase 1) — the cache is now BACKED by a PHI-free
  // persistent skeleton (task-skeleton-store). On construction we hydrate the
  // cache from disk so Home renders INSTANTLY on cold start, BEFORE the first
  // network round-trip. The hydrated rows carry the NON-PHI routing skeleton
  // (status/claim/counts/timestamps) but NO title — `title` falls back to the
  // opaque short id until the first list pull layers the (memory-only) titles
  // back on top. Order/filter/counts come from the skeleton; human text
  // hydrates from memory.
  private cache = new Map<string, SourcedTask>();
  // Serialized form of the last list, used to detect changes between polls
  // without diffing structurally.
  private lastSignature = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // fm-h8g7 — true until the first poll completes after construction / sign-in.
  // The first poll seeds the cache with the WHOLE existing inventory, which the
  // transition classifier would otherwise report as a burst of "new task"
  // notifications. We suppress 'new' on that first poll only.
  private firstPoll = true;

  // task-b1fe80e2669b (Phase 2) — delta-sync bookkeeping. `pollCount` counts
  // completed polls since the last FULL pull so we can periodically force a full
  // reconcile (the safety net for a missed tombstone). The persisted cursor
  // (sync_meta.sync_cursor) is the source of truth across restarts; this counter
  // is in-memory only and resets on each full pull.
  private pollCount = 0;

  // fm-b5at.10 — task ids whose session is mid-relaunch. The relaunch kills the
  // old PTY, whose onExit would otherwise fire the "Release this task?" prompt
  // (the user still holds the claim during the swap). We suppress that prompt
  // while a relaunch for the same task is in flight; the fresh session re-uses
  // the same claim, so there is nothing to release.
  private relaunching = new Set<string>();

  // ─── claim keep-alive (fm-cveh/S8) ───────────────────────────────────────
  // A re-claim by the current holder is an idempotent renew that refreshes the
  // 2h claim TTL (spec §1.5). While a Breeze-launched session for task X is
  // alive, we re-POST /claim once per ~90min so a long-running session (an
  // agent paused at an approval gate, say) never loses its claim to a
  // teammate mid-flight. Keyed by opaque task id → interval handle (PHI-free:
  // no titles/bodies ever touch this map).
  private keepAliveTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  // task-b3fb2928bb3c (Phase 1) — hydrate the in-memory cache from the
  // PHI-free persistent skeleton on construction so the first list/poll has a
  // last-known set to diff against AND Home renders instantly from disk before
  // any network round-trip. Hydrated rows carry NO title (PHI) — `title` is the
  // opaque short id placeholder until the first pull layers titles in memory.
  constructor() {
    try {
      const skeleton = loadLiveSkeleton();
      this.cache = new Map(
        skeleton.map((s) => [s.id, this.skeletonToCacheRow(s)]),
      );
    } catch (e) {
      // A corrupt/locked skeleton db must never block sign-in; start empty and
      // let the first pull rebuild it. PHI-free log (message only).
      console.warn('[typebuild] skeleton hydrate failed:', (e as Error).message);
      this.cache = new Map();
    }
  }

  // Build an in-memory cache row from a persisted NON-PHI skeleton row. The
  // title is unknown on disk (PHI lives in memory only), so we use the opaque
  // short id as a placeholder the first list pull overwrites with the real
  // (memory-only) title. notes stays null (body is fetched on demand).
  private skeletonToCacheRow(s: SkeletonTask): SourcedTask {
    return {
      id: s.id,
      title: `TypeBuild task ${shortId(s.id)}`,
      notes: null,
      status: s.status ?? 'pending',
      folder: undefined,
      start_at: null,
      due_at: s.due_at ?? null,
      pinned: false,
      cron: null,
      next_run_at: null,
      auto_mode: false,
      auto_agent: null,
      auto_prompt: null,
      created_at: s.created_at ?? Date.now(),
      updated_at: s.updated_at ?? Date.now(),
      completed_at: s.completed_at ?? null,
      source: 'typebuild',
      rawStatus: s.rawStatus,
      priority: s.priority,
      claimedBy: s.claimedBy ?? null,
      assignedTo: s.assignedTo ?? null,
      attempts: s.attempts,
      maxAttempts: s.maxAttempts,
      flags: Array.isArray(s.flags) ? s.flags : [],
      deferUntil: s.deferUntil ?? null,
      parentTaskId: s.parentTaskId ?? null,
      projectId: s.projectId ?? null,
      createdAtIso: s.createdAtIso ?? null,
      updatedAtIso: s.updatedAtIso ?? null,
      claimedAt: s.claimedAt ?? null,
    };
  }

  // Project an in-memory cache row to the NON-PHI skeleton shape the persistent
  // store accepts. STRUCTURALLY PHI-SAFE: it picks ONLY routing fields and
  // never reads `title`/`notes`, so task text cannot reach disk through here.
  private cacheRowToSkeleton(t: SourcedTask): SkeletonTask {
    return {
      id: t.id,
      status: t.status,
      rawStatus: t.rawStatus,
      claimedBy: t.claimedBy ?? null,
      assignedTo: t.assignedTo ?? null,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      flags: Array.isArray(t.flags) ? t.flags : [],
      priority: t.priority,
      due_at: t.due_at ?? null,
      deferUntil: t.deferUntil ?? null,
      projectId: t.projectId ?? null,
      parentTaskId: t.parentTaskId ?? null,
      created_at: t.created_at,
      updated_at: t.updated_at,
      completed_at: t.completed_at ?? null,
      createdAtIso: t.createdAtIso ?? null,
      updatedAtIso: t.updatedAtIso ?? null,
      claimedAt: t.claimedAt ?? null,
    };
  }

  // task-b3fb2928bb3c (Phase 1) — the cold-start → reconcile → diff-broadcast
  // core. Given a fresh server list (ListRow[]), rebuild the in-memory cache
  // (titles layered from the fresh payload, memory only), persist the NON-PHI
  // skeleton to disk computing the added/changed/removed diff, and return that
  // diff so the caller can broadcast ONLY what moved (not "everything changed").
  // PHI: only routing fields hit disk; titles/bodies stay in `this.cache`.
  private reconcileFromRows(rows: ListRow[]): SkeletonDiff {
    const fresh = new Map(rows.map((r) => [r.id, mapListRow(r)]));
    // Persist the NON-PHI skeleton + get the diff vs. what was live on disk.
    let diff: SkeletonDiff;
    try {
      diff = reconcileSkeleton(
        [...fresh.values()].map((t) => this.cacheRowToSkeleton(t)),
      );
    } catch (e) {
      // A persistence failure must not break the live list. Fall back to a
      // structural diff against the in-memory cache so the broadcast still
      // carries an honest (PHI-free) diff. Message-only log.
      console.warn('[typebuild] skeleton reconcile failed:', (e as Error).message);
      diff = diffSkeleton(
        [...this.cache.values()].map((t) => this.cacheRowToSkeleton(t)),
        [...fresh.values()].map((t) => this.cacheRowToSkeleton(t)),
      );
    }
    // Swap the in-memory cache to the fresh rows (titles in memory only).
    this.cache = fresh;
    return diff;
  }

  // task-b1fe80e2669b (Phase 2) — the DELTA analog of reconcileFromRows. Given
  // ONLY the changed rows + an explicit tombstone id list from a delta pull:
  // upsert the changed rows into the in-memory cache (titles memory-only),
  // DELETE the tombstoned ids from the cache (not inference — the server told
  // us they're gone), persist the same to the NON-PHI skeleton, and return the
  // added/changed/removed diff. The unchanged majority is left untouched in the
  // cache (the whole point of delta). PHI: only routing fields hit disk.
  private reconcileDelta(
    changedRows: ListRow[],
    tombstones: string[],
  ): SkeletonDiff {
    const changed = changedRows.map((r) => mapListRow(r));
    let diff: SkeletonDiff;
    try {
      diff = applyDeltaSkeleton(
        changed.map((t) => this.cacheRowToSkeleton(t)),
        tombstones,
      );
    } catch (e) {
      // Persistence failure must not break the live list. Fall back to a pure
      // in-memory delta diff so the broadcast still carries an honest diff.
      console.warn(
        '[typebuild] skeleton delta failed:',
        (e as Error).message,
      );
      diff = deltaSkeleton(
        [...this.cache.values()].map((t) => this.cacheRowToSkeleton(t)),
        changed.map((t) => this.cacheRowToSkeleton(t)),
        tombstones,
      );
    }
    // Apply to the in-memory cache: upsert changed, delete tombstoned.
    for (const t of changed) this.cache.set(t.id, t);
    for (const id of tombstones) this.cache.delete(id);
    return diff;
  }

  // Wrap a SkeletonDiff into the PHI-free broadcast detail for tasks:changed.
  private toChangedDetail(diff: SkeletonDiff): TasksChangedDetail {
    return {
      source: this.id,
      added: diff.added,
      changed: diff.changed,
      removed: diff.removed,
    };
  }

  // ─── REST helper ────────────────────────────────────────────────────────
  // One fetch with a Bearer token. On 401, retry once with a fresh token
  // (getIdToken auto-refreshes, but a token can be revoked mid-flight); a
  // second 401 surfaces as a signed-out error. 404 is returned as null by
  // callers that treat it as not-visible.
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const doFetch = async (): Promise<Response> => {
      const token = await getIdToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        // The server content-negotiates: without an explicit JSON Accept it
        // serves the HTML task-list page, which we then fail to parse as JSON
        // (data.tasks === undefined → silently-empty list). Ask for JSON on
        // every chromeext call. (Its wants_json() requires application/json
        // present AND text/html absent.)
        Accept: 'application/json',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let res = await doFetch();
    if (res.status === 401) {
      // getIdToken refreshes proactively, but the token could have been
      // revoked. Force a retry; a second 401 means we're really signed out.
      res = await doFetch();
      if (res.status === 401) {
        throw new Error('typebuild: signed out (401)');
      }
    }
    return res;
  }

  // ─── list ─────────────────────────────────────────────────────────────
  async listTasks(filter: TaskFilter): Promise<SourcedTask[]> {
    const params = new URLSearchParams({ titles: '1' });
    // Pull terminal states (done/partial/cancelled/blocked) when the filter
    // wants done rows. all=1 now also returns cancelled (fm-lji6/S2). The
    // renderer applies its own status filter on top.
    if (filter.includeDone !== false) params.set('all', '1');
    // fm-lji6 (S2) — the "Mine" toggle is server-backed: thread claimed_by=me
    // so the server returns only rows the signed-in principal holds. Only the
    // typebuild source consumes this filter member; local ignores it.
    if (filter.claimedByMe) params.set('claimed_by', 'me');

    // A per-call fetch failure (transient 5xx, token blip, network) must NOT
    // collapse this source's whole contribution to the aggregated list to
    // zero — that surfaces to the user as a silently-empty task list. The
    // background poll keeps `this.cache` fresh, so fall back to it on any
    // failure and serve the last-known rows instead of throwing. We only throw
    // when we have nothing cached to serve (cold start), so the caller can
    // distinguish "genuinely no data" from "stale-but-present".
    let rows: ListRow[];
    try {
      const res = await this.request('GET', `/chromeext/tasks?${params}`);
      if (!res.ok) throw new Error(`typebuild: list failed (${res.status})`);
      const data = (await res.json().catch(() => ({}))) as { tasks?: ListRow[] };
      rows = Array.isArray(data.tasks) ? data.tasks : [];
    } catch (err) {
      if (this.cache.size > 0) {
        // Serve stale-but-present cache; never log title/body content.
        console.warn(
          '[typebuild] list fetch failed, serving cache:',
          (err as Error).message,
        );
        return this.applyFilter([...this.cache.values()], filter);
      }
      throw err;
    }

    // task-b3fb2928bb3c (Phase 1) — refresh the in-memory cache from the fresh
    // list AND persist the NON-PHI skeleton to disk (titles stay memory-only).
    // reconcileFromRows swaps this.cache and upserts/tombstones the skeleton.
    this.reconcileFromRows(rows);
    this.lastSignature = this.signatureOf(rows);

    return this.applyFilter([...this.cache.values()], filter);
  }

  // Apply search/status filters IN MEMORY — PHI never hits local SQL. The
  // renderer also filters, but doing it here keeps the seam honest and the
  // payload small.
  private applyFilter(tasks: SourcedTask[], filter: TaskFilter): SourcedTask[] {
    let out = tasks;
    if (filter.status) {
      const wanted = Array.isArray(filter.status)
        ? new Set(filter.status)
        : new Set([filter.status]);
      out = out.filter((t) => wanted.has(t.status));
    }
    if (filter.includeDone === false) {
      out = out.filter((t) => t.status !== 'done');
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      out = out.filter((t) => t.title.toLowerCase().includes(q));
    }
    return out;
  }

  // ─── get (decrypted detail) ─────────────────────────────────────────────
  async getTask(id: string): Promise<SourcedTask | null> {
    const res = await this.request(
      'GET',
      `/chromeext/${encodeURIComponent(id)}`,
    );
    if (res.status === 404) return null; // not visible
    if (!res.ok) throw new Error(`typebuild: get failed (${res.status})`);
    const detail = (await res.json().catch(() => ({}))) as DetailRow;
    return this.mapDetail(detail, id);
  }

  // ─── claim-next (headless breezed loop — fm-typebuild-repoint) ────────────
  // POST /chromeext/tasks/claim-next — atomically claim the next runnable task
  // for this machine (the REST analog of the MCP `claim_next_task` verb). The
  // daemon's poll-claim-execute loop calls this; the GUI app does not.
  //
  // Server (verified live):
  //   200 → { ok, id, title, task, status, start_url, skill_ids, attempts,
  //           max_attempts, notes, flags, skills } — `task` is the DECRYPTED
  //           body (PHI). We map it through mapDetail so the body lands in
  //           `notes` (memory only) exactly like getTask.
  //   409 { ok:false, reason:'no_open_tasks' } → empty queue; return null.
  //   anything else → throw (the loop logs a PHI-free line and backs off).
  //
  // PHI: the decrypted body rides home in the returned SourcedTask.notes and
  // lives in daemon memory only. We never log it and never seed it into the
  // poll cache's persisted/broadcast path here (the daemon doesn't poll).
  async claimNext(): Promise<SourcedTask | null> {
    const res = await this.request('POST', '/chromeext/tasks/claim-next');
    if (res.status === 409) {
      // Empty queue (reason:'no_open_tasks') — the normal "nothing to do"
      // answer, not an error. Drain the body so the socket frees cleanly.
      await res.json().catch(() => ({}));
      return null;
    }
    if (!res.ok) {
      throw new Error(`typebuild: claim-next failed (${res.status})`);
    }
    const detail = (await res.json().catch(() => ({}))) as DetailRow & {
      ok?: boolean;
    };
    if (detail.ok === false) {
      // Defensive: server signalled no-task with a 200 body.
      return null;
    }
    const id = detail.id ?? '';
    if (!id) throw new Error('typebuild: claim-next returned no id');
    return this.mapDetail(detail, id);
  }

  // Map a decrypted detail row into a SourcedTask. The body (`task`) goes into
  // `notes` — that's what the existing detail UI renders. Memory only.
  private mapDetail(detail: DetailRow, fallbackId: string): SourcedTask {
    const base = mapListRow({ ...detail, id: detail.id ?? fallbackId });
    return {
      ...base,
      // Decrypted body → notes (PHI; rendered from React state only).
      notes: detail.task ?? detail.notes ?? null,
      // task-b8306d2b85c2 — lifecycle timestamps (NON-PHI). `claimed_at` is on
      // the detail wire (string ISO or epoch); normalize to an ISO string so
      // the UI's relative-age + near-expiry math has one shape. created_at/
      // updated_at/created_by pass through verbatim when the server returns
      // them (typed-optional — the list endpoint carries no timestamps).
      claimedAt: toIso(detail.claimed_at),
      createdAtIso: detail.created_at ?? null,
      updatedAtIso: detail.updated_at ?? null,
      createdBy: detail.created_by ?? null,
      // fm-lji6 (S2) — dependency fields (detail only). Memory-only; ids are
      // opaque (non-PHI). Used by S3's "waiting on N tasks" presentation.
      dependsOn: Array.isArray(detail.depends_on) ? detail.depends_on : undefined,
      depsSatisfied:
        typeof detail.deps_satisfied === 'boolean'
          ? detail.deps_satisfied
          : undefined,
      blockedBy: Array.isArray(detail.blocked_by) ? detail.blocked_by : undefined,
      // task-19ba9f7f43f1 — structured result (bespoke rendering). Pass it
      // through ONLY when it's a well-shaped { type: string, payload } object;
      // anything else is dropped so the client cleanly falls back to notes. The
      // payload is task OUTPUT (potentially PHI) and, like `notes`, lives in the
      // returned SourcedTask in MEMORY only — the skeleton store has no result
      // column, so it can never reach disk through the poll cache.
      result: mapResult(detail.result),
      // task-da23979fd907 — the USER-facing message feed. Pass it through ONLY
      // when the wire carries a well-shaped array with at least one text-bearing
      // entry; absent/empty/malformed → undefined so a message-less task renders
      // exactly as today (NON-REGRESSION). `text` is decrypted PHI and, like
      // `notes`, lives in the returned SourcedTask in MEMORY only — the skeleton
      // store has no messages column, so it never reaches disk through the cache.
      messages: mapMessages(detail.messages),
      // task-91d13f9d5469 — the VERIFIED-on-detail pending question. mapListRow
      // (via base) already normalized detail.pending_question, but we re-map it
      // here explicitly so the detail value is authoritative and this mirrors
      // result/messages. Pass-through ONLY when well-shaped ({ text }); absent/
      // null/malformed → undefined so a question-less task renders as today
      // (NON-REGRESSION). `text` is decrypted PHI, memory-only (no skeleton col).
      pending_question: mapPendingQuestion(detail.pending_question),
      // task-896f3f7f5e75 — the RESOLVED agent block get_task inlines alongside
      // the scalar agent_id. Passed through ONLY when well-shaped (an object
      // with id + name); absent/malformed → null so a task with no agent renders
      // exactly as today (the detail line is simply omitted — NON-REGRESSION).
      // NON-PHI (an agent identity). The scalar agentId already came through
      // mapListRow (via base) above.
      agent: mapResolvedAgent(detail.agent),
      // task-ce4b4c8ca955 — server-declared output field schema (S2), for
      // single-task (non-chained) jobs. NON-PHI (definitions only); see
      // mapOutputSchema + the DetailRow.output_schema comment.
      outputSchema: mapOutputSchema(detail.output_schema),
      // task-4a8d2c98f667 — Inputs section key list (NON-PHI names only).
      // Defensive: drop non-string entries rather than rejecting the whole
      // array, same fail-soft convention as mapOutputSchema; absent/malformed
      // → undefined so a task with no data_keys renders exactly as before.
      dataKeys: mapDataKeys(detail.data_keys),
    };
  }

  // ─── create (fm-r8vj/S5 plumbing) ────────────────────────────────────────
  // POST /chromeext/tasks. The v1 extension creates with { title, task,
  // start_url?, skill_ids?, flags? }; v2 adds priority, due_at, defer_until,
  // parent_task_id, depends_on (spec §3 create_task / _build_task_from_payload).
  // We map the Breeze TaskCreate → that payload: title + notes → title/task
  // body. Titles/bodies ARE sent to the server (it encrypts them at rest); the
  // PHI invariant only forbids PERSISTING them locally — so we never write them
  // to disk/logs, and the returned SourcedTask carries them in memory only.
  // On 201 we patch the cache + broadcast and return the mapped row.
  async createTask(input: TaskCreate): Promise<SourcedTask> {
    const title = (input.title ?? '').trim();
    const body = (input.notes ?? '')?.trim() ?? '';
    if (!title && !body) {
      throw new Error('typebuild: title or body is required');
    }
    // task-a7214605a998 — the per-task field mapping is shared with bulkCreateTasks
    // (buildCreatePayload below) so a batched create is byte-identical to N plain
    // creates, one schema, no drift.
    const payload = this.buildCreatePayload(input);

    const res = await this.request('POST', '/chromeext/tasks', payload);
    if (!res.ok) {
      // 400 (validation) / 403 (group membership). Surface the server reason
      // without logging the PHI title/body.
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      throw new Error(
        `typebuild: create failed (${res.status})${
          data.reason ? `: ${data.reason}` : data.error ? `: ${data.error}` : ''
        }`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
    };
    const id = data.id ?? '';
    if (!id) throw new Error('typebuild: create returned no id');

    // Mint the SourcedTask from the input + returned id (the create response
    // does NOT echo the title back). Seed the cache so the new row appears on
    // the next pull, then broadcast.
    const mapped = mapListRow({
      id,
      status: data.status ?? 'open',
      raw_status: data.status ?? 'open',
      title,
      priority: typeof input.priority === 'number' ? input.priority : undefined,
      due_at: input.due_at ?? null,
      defer_until: input.deferUntil ?? null,
      project_id: input.projectId ?? null,
      // task-896f3f7f5e75 — seed the scalar agent_id so the just-created row
      // shows its assignment immediately; the resolved `agent` block arrives on
      // the next detail fetch. Non-PHI.
      agent_id: input.agentId ?? null,
      // task-fd1be6f6b22d — seed assigned_to so a just-created manual task
      // shows its assignee immediately (NON-PHI email/principal).
      assigned_to: input.assignedTo ?? null,
      // task-83a30b3c8804 — seed parent_task_id so the just-created row
      // reflects chain-container membership immediately, without waiting on a
      // detail re-fetch. `depends_on` is a DetailRow-only field (ListRow has
      // no slot for it) — the next detail fetch picks it up instead.
      parent_task_id: input.parentTaskId ?? null,
    });
    // notes (the body) is PHI-in-memory; attach it for the immediate return so
    // the composer can show the just-created task without a re-fetch.
    const seeded: SourcedTask = { ...mapped, notes: body || null };
    this.cache.set(id, seeded);
    breezeHost().onTasksChanged();
    void this.refreshAndBroadcast();
    return seeded;
  }

  // task-a7214605a998 — the create payload mapping, extracted so createTask AND
  // bulkCreateTasks share ONE field mapping (a bulk create is createTask batched,
  // not a second schema). Maps a TaskCreate to the server's /chromeext/tasks body
  // (title/task/due_at/priority/project_id/agent_id/assigned_to/parent_task_id/
  // depends_on/recurrence/output_schema/data). Fields are omitted when unset/empty
  // so the payload is byte-identical to the plain create path (NON-REGRESSION).
  // PHI: title/body/data ride in memory only, never logged.
  private buildCreatePayload(input: TaskCreate): Record<string, unknown> {
    const title = (input.title ?? '').trim();
    const body = (input.notes ?? '')?.trim() ?? '';
    const payload: Record<string, unknown> = { title, task: body };
    // due_at: the composer passes day-only or ISO; pass it straight through
    // (the server stores the ISO string verbatim). Omit when null/empty.
    if (input.due_at) payload.due_at = input.due_at;
    if (input.deferUntil) payload.defer_until = input.deferUntil;
    if (typeof input.priority === 'number') payload.priority = input.priority;
    // task-ab1d7955e23f — optional project container. Opaque id (non-PHI).
    if (input.projectId) payload.project_id = input.projectId;
    // task-896f3f7f5e75 — optional assigned AGENT (scalar; opaque id, non-PHI).
    if (input.agentId) payload.agent_id = input.agentId;
    // task-fd1be6f6b22d — optional assignee (server `assigned_to`, an email/
    // principal — NON-PHI).
    if (input.assignedTo) payload.assigned_to = input.assignedTo;
    // task-83a30b3c8804 — optional structural chain linking (opaque ids, non-PHI).
    if (input.parentTaskId) payload.parent_task_id = input.parentTaskId;
    if (input.dependsOn && input.dependsOn.length > 0) payload.depends_on = input.dependsOn;
    // task-7bdb94445321 — optional repeat schedule (RRULE-lite, NON-PHI).
    if (input.recurrence) payload.recurrence = input.recurrence;
    // task-a7214605a998 (S6) — structured output field schema (S2, NON-PHI:
    // key/label/type/options/required only) + data map (S1, PHI form-fill value
    // bag; keys become the server's data_keys). Both ride as first-class fields
    // under the server's own names (output_schema/data) instead of the composer
    // embedding ```task-outputs/```task-fields fenced blocks in the body. Only
    // sent when non-empty to avoid a no-op payload key.
    if (Array.isArray(input.outputSchema) && input.outputSchema.length > 0) {
      payload.output_schema = input.outputSchema;
    }
    if (input.data && typeof input.data === 'object' && Object.keys(input.data).length > 0) {
      payload.data = input.data;
    }
    return payload;
  }

  // task-a7214605a998 (final model) — a CHAIN is an ORDERED LIST OF SAVED
  // TEMPLATES; it is created NOT via /tasks/bulk (that was the earlier inline-
  // field model) but by instantiating each referenced template in order and
  // linking the resulting tasks. That orchestration lives in the renderer's
  // testable `instantiateChain` seam (src/components/newhome/newHomePrefs.ts),
  // wired to fm.tasksCreate (parent) + fm.typebuild.templates.instantiate
  // (children) + sourceAction('patch') for parent_task_id/depends_on linkage —
  // the last of which patchFields now forwards (see below).

  updateTask(_id: string, _patch: TaskUpdate): never {
    // Edits go through sourceAction('patch') (fm-j7w0/S4), not the local-style
    // updateTask path — canEdit is false for this source.
    throw unsupported('updateTask — use the patch source action for TypeBuild');
  }

  // ─── delete (fm-iwlc/S6) ─────────────────────────────────────────────────
  // DELETE /chromeext/{id}. Hard delete, creator-only (spec §1.9): 403 with
  // reason `not_owner`, 409 with reason `in_progress_elsewhere`. deleteTask is
  // the void/throwing TaskSource contract — the local source throws on failure
  // and the renderer's catch (useTaskActions.remove → formatOpError) shows the
  // message. We throw an Error whose message embeds the server reason as
  // `[typebuild-delete:<reason>]` so the renderer can pull it out and route it
  // through formatSourceReason (not_owner / in_progress_elsewhere humanize to
  // distinct status-line text). On 200 we drop the row from the cache and
  // broadcast so the list updates without waiting for the poll. PHI-free: no
  // title/body is logged or carried.
  async deleteTask(id: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/chromeext/${encodeURIComponent(id)}`,
    );
    if (res.status === 200 || res.status === 204) {
      this.cache.delete(id);
      breezeHost().onTasksChanged();
      void this.refreshAndBroadcast();
      return;
    }
    if (res.status === 403 || res.status === 409 || res.status === 404) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        data.reason ??
        (res.status === 403
          ? 'not_owner'
          : res.status === 409
            ? 'in_progress_elsewhere'
            : 'not visible');
      throw new Error(`[typebuild-delete:${reason}]`);
    }
    throw new Error(`typebuild: delete failed (${res.status})`);
  }

  // ─── projects (task-ab1d7955e23f) ────────────────────────────────────────
  // Project containers over /chromeext/projects. NON-PHI (names/instructions/
  // folders are not patient data), but we still never log request/response
  // bodies. All four verbs map the snake_case server JSON → the camelCase
  // `Project` through `mapProjectRow`.

  // Map a raw server project row → the camelCase client `Project`.
  private mapProjectRow(raw: ProjectRow): Project {
    const project: Project = {
      id: raw.id,
      name: raw.name,
      description: raw.description ?? null,
      instructions: raw.instructions ?? null,
      parentProjectId: raw.parent_project_id ?? null,
      folders: Array.isArray(raw.folders) ? raw.folders : [],
      createdBy: raw.created_by ?? null,
      groupId: raw.group_id ?? null,
      createdAt: raw.created_at ?? null,
      updatedAt: raw.updated_at ?? null,
    };
    if (typeof raw.effective_instructions === 'string') {
      project.effectiveInstructions = raw.effective_instructions;
    }
    if (typeof raw.archived === 'boolean') {
      project.archived = raw.archived;
    }
    return project;
  }

  // GET /chromeext/projects → { projects: [...] }. Returns [] on a parse miss.
  // task-2c5448be520a — archived projects are omitted by default; pass
  // { includeArchived: true } (→ ?archived=1) to fetch them too for the
  // "Show archived" toggle.
  async listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]> {
    const qs = opts?.includeArchived ? '?archived=1' : '';
    // task-b3fb2928bb3c (Phase 1) — projects are NON-PHI and had no cache; a
    // transient fetch failure used to surface as an empty project list. Serve
    // the persisted project skeleton (id + name + archived) on any failure so
    // cold start / a blip still renders project names. We only fall through to
    // throw when we have nothing cached.
    let rows: ProjectRow[];
    try {
      const res = await this.request('GET', `/chromeext/projects${qs}`);
      if (!res.ok) {
        throw new Error(`typebuild: list projects failed (${res.status})`);
      }
      const data = (await res.json().catch(() => ({}))) as {
        projects?: ProjectRow[];
      };
      rows = Array.isArray(data.projects) ? data.projects : [];
    } catch (err) {
      try {
        const cached = loadProjectSkeleton();
        if (cached.length > 0) {
          console.warn(
            '[typebuild] list projects failed, serving skeleton:',
            (err as Error).message,
          );
          return cached
            .filter((p) => (opts?.includeArchived ? true : !p.archived))
            .map((p) => ({
              id: p.id,
              name: p.name,
              description: null,
              instructions: null,
              parentProjectId: null,
              folders: [],
              createdBy: null,
              groupId: null,
              createdAt: null,
              updatedAt: null,
              archived: p.archived,
            }));
        }
      } catch {
        /* skeleton unavailable — fall through to the original throw */
      }
      throw err;
    }
    const projects = rows.map((r) => this.mapProjectRow(r));
    // Persist the NON-PHI project skeleton (id + name + archived) for cold
    // start. Only when we fetched the FULL list (no archived filter narrowing
    // it) so we don't drop archived rows the default fetch omits.
    try {
      if (opts?.includeArchived) reconcileProjects(projects);
    } catch (e) {
      console.warn('[typebuild] project skeleton persist failed:', (e as Error).message);
    }
    return projects;
  }

  // ─── agents (task-896f3f7f5e75) ──────────────────────────────────────────
  // GET /chromeext/agents → { agents: [...] }. MIRRORS listProjects' fetch: the
  // agent registry the composer picker lists. Agents are NON-PHI (name/tools/
  // launch_mode) — but we still never log request/response bodies. Returns [] on
  // a parse miss (same contract as listProjects' `Array.isArray(...) ? ... : []`)
  // so a malformed response degrades to "only the None option" rather than a
  // crash. Malformed individual rows are dropped by mapAgentRow. Unlike projects
  // there is no skeleton cache (agents aren't needed cold; the picker fetches on
  // open), so a transient failure surfaces as a throw the caller catches → empty
  // list → None-only picker.
  async listAgents(): Promise<Agent[]> {
    const res = await this.request('GET', '/chromeext/agents');
    if (!res.ok) {
      throw new Error(`typebuild: list agents failed (${res.status})`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      agents?: AgentRow[];
    };
    const rows = Array.isArray(data.agents) ? data.agents : [];
    const out: Agent[] = [];
    for (const r of rows) {
      const a = mapAgentRow(r);
      if (a) out.push(a);
    }
    return out;
  }

  // ─── group members (task-fd1be6f6b22d) ──────────────────────────────────
  // The human principals the composer's "Who runs this?" picker lists next to
  // Claude Code. Prefer GET /chromeext/groups/members (deduped ACTIVE members +
  // self, mirroring the agents endpoint: { members: [...] }). If that route
  // isn't deployed yet (404), FALL BACK to GET /chromeext/groups → { groups:
  // [{ members: [{ principal, role, status }] }] } and dedupe status==='active'
  // client-side. Any other failure throws → the caller catches → empty list →
  // the picker degrades to the plain Manual/Claude fallback (NON-REGRESSION).
  async listGroupMembers(): Promise<GroupMember[]> {
    const primary = await this.request('GET', '/chromeext/groups/members');
    if (primary.ok) {
      const data = (await primary.json().catch(() => ({}))) as {
        members?: GroupMemberRow[];
      };
      return dedupeMembers(Array.isArray(data.members) ? data.members : []);
    }
    if (primary.status === 404) {
      const res = await this.request('GET', '/chromeext/groups');
      if (!res.ok) {
        throw new Error(`typebuild: list groups failed (${res.status})`);
      }
      const data = (await res.json().catch(() => ({}))) as {
        groups?: { members?: GroupMemberRow[] }[];
      };
      const rows: GroupMemberRow[] = [];
      for (const g of Array.isArray(data.groups) ? data.groups : []) {
        for (const m of Array.isArray(g.members) ? g.members : []) {
          // status absent → treat as active (be lenient); otherwise require it.
          if (m && (m.status === undefined || m.status === 'active')) rows.push(m);
        }
      }
      return dedupeMembers(rows);
    }
    throw new Error(`typebuild: list group members failed (${primary.status})`);
  }

  // ─── templates (task-e112d60a3b7c) ───────────────────────────────────────
  // The first-class Template API (/chromeext/templates), superseding the old
  // client-side task-scanning "template" derivation. NON-PHI on the list; the
  // detail decrypts `notes` (memory-only). We never log request/response bodies.

  // Map a raw server template row → the camelCase client `Template`. Defensive:
  // a row missing an id yields null (dropped) so a malformed entry never reaches
  // the picker. variables/output_schema reuse mapOutputSchema (fail-soft: bad
  // entries dropped) and default to [] when absent/empty.
  private mapTemplateRow(raw: TemplateRow | null | undefined): Template | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) return null;
    const template: Template = {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      projectId: raw.project_id ?? null,
      variables: mapOutputSchema(raw.variables) ?? [],
      outputSchema: mapOutputSchema(raw.output_schema) ?? [],
      agentId: raw.agent_id ?? null,
      flags: Array.isArray(raw.flags)
        ? raw.flags.filter((f): f is string => typeof f === 'string')
        : [],
      createdBy: raw.created_by ?? null,
      groupId: raw.group_id ?? null,
      createdAt: raw.created_at ?? null,
      updatedAt: raw.updated_at ?? null,
    };
    // notes is present only on the detail fetch (PHI, memory-only).
    if (typeof raw.notes === 'string') template.notes = raw.notes;
    return template;
  }

  // GET /chromeext/templates?project_id=<id>&include_global=true&include_archived=false
  // → { templates: [...] }. NON-PHI list (no `notes`). `projectId` is optional
  // (omit the param when absent); include_global is always on so shared/global
  // templates show alongside a project's own. Malformed rows are dropped.
  async listTemplates(projectId?: string): Promise<Template[]> {
    const params = new URLSearchParams({
      include_global: 'true',
      include_archived: 'false',
    });
    if (projectId) params.set('project_id', projectId);
    const res = await this.request('GET', `/chromeext/templates?${params}`);
    if (!res.ok) {
      throw new Error(`typebuild: list templates failed (${res.status})`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      templates?: TemplateRow[];
    };
    const rows = Array.isArray(data.templates) ? data.templates : [];
    const out: Template[] = [];
    for (const r of rows) {
      const t = this.mapTemplateRow(r);
      if (t) out.push(t);
    }
    return out;
  }

  // GET /chromeext/templates/{id} → the full template including the decrypted
  // `notes` prompt body (PHI — memory-only, never logged/persisted). 404 → null.
  async getTemplate(id: string): Promise<Template | null> {
    const res = await this.request(
      'GET',
      `/chromeext/templates/${encodeURIComponent(id)}`,
    );
    if (res.status === 404) {
      await res.json().catch(() => ({}));
      return null;
    }
    if (!res.ok) {
      throw new Error(`typebuild: get template failed (${res.status})`);
    }
    const raw = (await res.json().catch(() => ({}))) as
      | TemplateRow
      | { template?: TemplateRow };
    // Accept either the bare row or a { template } envelope.
    const row =
      raw && typeof raw === 'object' && 'template' in raw && raw.template
        ? (raw as { template: TemplateRow }).template
        : (raw as TemplateRow);
    return this.mapTemplateRow(row);
  }

  // POST /chromeext/templates/{id}/instantiate { values, title_override?,
  // project_id? } → { ok, id, status:'open' } — the server creates a REAL task
  // (data bag from `values`, output_schema copied, project/agent/flags
  // inherited) and returns its id. `values` MAY be PHI (typed field values) —
  // they ride the encrypted request body only, never logged. On success we
  // refresh + broadcast so the new task appears without waiting for the poll.
  async instantiateTemplate(
    templateId: string,
    values: Record<string, string>,
    titleOverride?: string,
    projectId?: string,
  ): Promise<{ id: string; status: string }> {
    const payload: Record<string, unknown> = { values: values ?? {} };
    if (titleOverride && titleOverride.trim()) {
      payload.title_override = titleOverride.trim();
    }
    if (projectId) payload.project_id = projectId;
    const res = await this.request(
      'POST',
      `/chromeext/templates/${encodeURIComponent(templateId)}/instantiate`,
      payload,
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      throw new Error(
        `typebuild: instantiate failed (${res.status})${
          data.reason ? `: ${data.reason}` : data.error ? `: ${data.error}` : ''
        }`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
    };
    const id = data.id ?? '';
    if (!id) throw new Error('typebuild: instantiate returned no id');
    // A new task exists server-side — surface it locally without waiting on the
    // 30s poll (same pattern as createTask/deleteTask).
    breezeHost().onTasksChanged();
    void this.refreshAndBroadcast();
    return { id, status: data.status ?? 'open' };
  }

  // GET /chromeext/projects/{id}(?effective=1). 404 (not found / not visible)
  // → null, mirroring resolve's "no owner" answer.
  async getProject(
    id: string,
    opts?: { effective?: boolean },
  ): Promise<Project | null> {
    const qs = opts?.effective ? '?effective=1' : '';
    const res = await this.request(
      'GET',
      `/chromeext/projects/${encodeURIComponent(id)}${qs}`,
    );
    if (res.status === 404) {
      await res.json().catch(() => ({}));
      return null;
    }
    if (!res.ok) {
      throw new Error(`typebuild: get project failed (${res.status})`);
    }
    const raw = (await res.json().catch(() => ({}))) as ProjectRow;
    if (!raw || !raw.id) return null;
    return this.mapProjectRow(raw);
  }

  // GET /chromeext/projects/resolve?folder=<enc> → { project: ...|null }. The
  // auto-attach lookup: returns null (not an error) when no project owns the
  // folder.
  async resolveProjectFolder(folder: string): Promise<Project | null> {
    const res = await this.request(
      'GET',
      `/chromeext/projects/resolve?folder=${encodeURIComponent(folder)}`,
    );
    if (!res.ok) {
      throw new Error(`typebuild: resolve project failed (${res.status})`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      project?: ProjectRow | null;
    };
    return data.project ? this.mapProjectRow(data.project) : null;
  }

  // POST /chromeext/projects → 201 { ok, id, project }. On !ok surface the
  // server reason (400 { reason|error }, 422 PHI-guard rejection) WITHOUT
  // logging the body.
  async createProject(input: {
    name: string;
    description?: string;
    instructions?: string;
    parentProjectId?: string;
    folders?: string[];
  }): Promise<Project> {
    const payload: Record<string, unknown> = { name: input.name };
    if (input.description !== undefined) payload.description = input.description;
    if (input.instructions !== undefined) {
      payload.instructions = input.instructions;
    }
    if (input.parentProjectId) {
      payload.parent_project_id = input.parentProjectId;
    }
    if (input.folders !== undefined) payload.folders = input.folders;

    const res = await this.request('POST', '/chromeext/projects', payload);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      const detail = data.reason ?? data.error ?? '';
      const phi =
        res.status === 422 ? ' (rejected by PHI guard)' : '';
      throw new Error(
        `typebuild: create project failed (${res.status})${
          detail ? `: ${detail}` : ''
        }${phi}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      project?: ProjectRow;
      id?: string;
    };
    if (!data.project || !data.project.id) {
      throw new Error('typebuild: create project returned no project');
    }
    return this.mapProjectRow(data.project);
  }

  // ─── update project (task-fdf3dc6b3c5c — teach-in-the-moment write-back) ───
  // PATCH /chromeext/projects/{id}. The teach affordance's PROJECT scope writes
  // a correction into a project's `instructions` here. NON-PHI (instructions are
  // teaching context, not patient data) — but we still never log the body.
  //
  // Server contract (verified against patch_project, chromeext.py ~1718):
  //   - OWNER-ONLY: 403 { reason:'not_owner' } when created_by != the caller.
  //   - PHI-GUARDED: 422 when name/description/instructions look PHI-shaped.
  //   - 404 when the project is not visible / not found.
  //   - 200 → { project } (the updated row).
  // We surface 403/422/404 as a STRUCTURED { ok:false, reason } so the renderer
  // can show a clear message instead of crashing (the teach UI keeps its local
  // fallback on a structured failure). Other non-2xx throw (genuine error).
  async updateProject(
    id: string,
    patch: { name?: string; description?: string; instructions?: string },
  ): Promise<
    | { ok: true; project: Project }
    | { ok: false; reason: string; status: number }
  > {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.instructions !== undefined) body.instructions = patch.instructions;

    const res = await this.request(
      'PATCH',
      `/chromeext/projects/${encodeURIComponent(id)}`,
      body,
    );
    if (res.status === 200) {
      const data = (await res.json().catch(() => ({}))) as {
        project?: ProjectRow;
      };
      if (!data.project || !data.project.id) {
        throw new Error('typebuild: update project returned no project');
      }
      return { ok: true, project: this.mapProjectRow(data.project) };
    }
    if (res.status === 403 || res.status === 404 || res.status === 422) {
      const data = (await res.json().catch(() => ({}))) as {
        reason?: string;
        error?: string;
      };
      // 403 → not_owner; 422 → PHI guard rejection; 404 → not visible.
      const reason =
        data.reason ??
        (res.status === 403
          ? 'not_owner'
          : res.status === 422
            ? 'phi_rejected'
            : 'not_visible');
      return { ok: false, reason, status: res.status };
    }
    throw new Error(`typebuild: update project failed (${res.status})`);
  }

  // ─── per-task teach note (task-fdf3dc6b3c5c — TASK scope write-back) ───────
  // POST /chromeext/{id}/notes — the dedicated NON-PHI progress-note endpoint
  // (field `note`). The teach affordance's TASK scope writes a per-task
  // instruction here. NON-PHI (teaching text, never patient data) — but we
  // never log the body. Server contract (verified against add_task_note,
  // chromeext.py ~2717): requires you hold the claim; 422 on PHI-shaped text;
  // 400 on empty; 404 not found; 409 claim conflict. We surface those as a
  // STRUCTURED { ok:false, reason } so the renderer keeps its local fallback
  // and shows a clear message rather than crashing.
  async addTaskNote(
    taskId: string,
    note: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/notes`,
      { note },
    );
    if (res.status === 200 || res.status === 201) {
      await res.json().catch(() => ({}));
      return { ok: true };
    }
    if (
      res.status === 400 ||
      res.status === 404 ||
      res.status === 409 ||
      res.status === 422
    ) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        data.reason ??
        (res.status === 422
          ? 'phi_rejected'
          : res.status === 409
            ? 'claim_conflict'
            : res.status === 400
              ? 'empty'
              : 'not_visible');
      return { ok: false, reason, status: res.status };
    }
    throw new Error(`typebuild: add task note failed (${res.status})`);
  }

  // ─── task message (task-da23979fd907 — USER-facing status channel) ─────────
  // POST /chromeext/{id}/messages — append to the append-only, USER-facing
  // message feed (field `text`). DISTINCT from addTaskNote: this is NOT
  // claim-gated (anyone who can see the task may append; posting does NOT
  // require in_progress and does NOT renew a claim). The server returns the
  // appended message + a { count }; we don't need the echo (the caller re-fetches
  // the detail to render the feed), so we discard the body on success.
  //
  // PHI: `text` IS patient-visible content — sent to the server (which encrypts
  // it at rest) but NEVER logged locally (the request helper never logs bodies).
  //
  // Server contract (verified): empty text → 400; a non-viewer → 404. We mirror
  // addTaskNote's STRUCTURED { ok:false, reason } so the compose box surfaces a
  // clear message and keeps its draft rather than crashing.
  async postTaskMessage(
    taskId: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/messages`,
      { text },
    );
    if (res.status === 200 || res.status === 201) {
      await res.json().catch(() => ({}));
      return { ok: true };
    }
    if (res.status === 400 || res.status === 404 || res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        data.reason ??
        (res.status === 400
          ? 'empty'
          : res.status === 409
            ? 'conflict'
            : 'not_visible');
      return { ok: false, reason, status: res.status };
    }
    throw new Error(`typebuild: post task message failed (${res.status})`);
  }

  // ─── answer a pending question (task-a763ca5be676 — INLINE reply) ──────────
  // POST /chromeext/{id}/answer — the REST equivalent of the `answer_question`
  // MCP tool. Clears the task's `pending_question` AND records the reply on the
  // task's message feed in one server-side step. Task-scoped verb, exactly like
  // /messages, /notes, /claim, /release. Field name is `answer`.
  //
  // Server contract (VERIFIED — 16 smoke checks): nothing pending → 409
  // { ok:false, reason:'no_pending_question' }; a non-viewer → 404; empty answer
  // → 400. We mirror postTaskMessage's STRUCTURED { ok:false, reason } so the
  // inline reply box surfaces a clear message and keeps the draft rather than
  // crashing.
  //
  // PHI: `answer` is patient-visible content — sent to the server (encrypted at
  // rest) but NEVER logged locally (the request helper never logs bodies).
  async answerQuestion(
    taskId: string,
    answer: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/answer`,
      { answer },
    );
    if (res.status === 200 || res.status === 201) {
      await res.json().catch(() => ({}));
      return { ok: true };
    }
    if (res.status === 400 || res.status === 404 || res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        data.reason ??
        (res.status === 409
          ? 'no_pending_question'
          : res.status === 400
            ? 'empty'
            : 'not_visible');
      return { ok: false, reason, status: res.status };
    }
    throw new Error(`typebuild: answer question failed (${res.status})`);
  }

  // ─── ask_user (task-c926bbe959f6 — the ask/answer protocol client leg) ─────
  // POST /chromeext/{id}/ask — set the task's `pending_question` (the field
  // mapPendingQuestion() reads on the detail/list rows), the REST analog of the
  // MCP `ask_user` verb. Cleared server-side by `answer_question`. This is the
  // provider-AGNOSTIC protocol call; the Stop-hook backstop (a Claude-Code
  // adapter) is one caller, but nothing here is Claude-specific.
  //
  // PHI: `text` is the (possibly patient-visible) question — sent to the server,
  // which encrypts pending_question at rest (verified). NEVER logged locally
  // (the request helper never logs bodies). Callers that can't safely extract a
  // PHI-free question pass a generic string instead (see the backstop).
  //
  // We surface non-2xx as a STRUCTURED { ok:false, reason } (never throw on the
  // expected 400/404/409) so a best-effort backstop degrades quietly rather
  // than crashing a hook-driven POST.
  async askUser(
    taskId: string,
    text: string,
    options?: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
    const body: Record<string, unknown> = { text };
    if (options && options.length) body.options = options;
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/ask`,
      body,
    );
    if (res.status === 200 || res.status === 201) {
      await res.json().catch(() => ({}));
      // Reflect optimistically so the "asked" attention bucket lights up before
      // the next poll. PHI-safe fields only reach the persisted skeleton; the
      // question text stays in the in-memory cache row.
      const row = this.cache.get(taskId);
      if (row) {
        this.cache.set(taskId, {
          ...row,
          pending_question: {
            text,
            ...(options && options.length ? { options } : {}),
          },
        });
        breezeHost().onTasksChanged();
      }
      return { ok: true };
    }
    if (
      res.status === 400 ||
      res.status === 404 ||
      res.status === 409 ||
      res.status === 422
    ) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        data.reason ??
        (res.status === 422
          ? 'phi_rejected'
          : res.status === 409
            ? 'claim_conflict'
            : res.status === 400
              ? 'empty'
              : 'not_visible');
      return { ok: false, reason, status: res.status };
    }
    throw new Error(`typebuild: ask_user failed (${res.status})`);
  }

  // POST /chromeext/projects/{id}/archive | /unarchive (task-2c5448be520a).
  // Distinct, single-purpose verbs (NOT a generic update PATCH — that path is
  // owned by a sibling task) so the two write paths don't collide. Returns the
  // updated project when the server echoes one; otherwise re-fetches it so the
  // caller always gets the new `archived` state. NON-PHI; bodies never logged.
  private async setArchived(id: string, archived: boolean): Promise<Project> {
    const verb = archived ? 'archive' : 'unarchive';
    const res = await this.request(
      'POST',
      `/chromeext/projects/${encodeURIComponent(id)}/${verb}`,
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      const detail = data.reason ?? data.error ?? '';
      throw new Error(
        `typebuild: ${verb} project failed (${res.status})${
          detail ? `: ${detail}` : ''
        }`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      project?: ProjectRow;
    };
    if (data.project && data.project.id) {
      return this.mapProjectRow(data.project);
    }
    // Server didn't echo the row — fetch it so callers get the new state. If
    // the (now-archived) project is no longer visible, synthesize the flag.
    const fetched = await this.getProject(id).catch(() => null);
    if (fetched) return { ...fetched, archived };
    return {
      id,
      name: '',
      description: null,
      instructions: null,
      parentProjectId: null,
      folders: [],
      createdBy: null,
      groupId: null,
      createdAt: null,
      updatedAt: null,
      archived,
    };
  }

  /** Archive a project (hidden from the default list). */
  archiveProject(id: string): Promise<Project> {
    return this.setArchived(id, true);
  }

  /** Unarchive a project (restore it to the default list). */
  unarchiveProject(id: string): Promise<Project> {
    return this.setArchived(id, false);
  }

  // ─── delete project (task-a9841cfc0e1b — project CRUD UI) ─────────────────
  // DELETE /chromeext/projects/{id}. Mirrors the task-delete structured-error
  // contract above: the server refuses to delete a project that still has
  // tasks (the UI should offer archive instead), or one the caller doesn't
  // own. NON-PHI; body never logged.
  //
  // Server contract (mirrors deleteTask's verified shape):
  //   - 200/204 → deleted.
  //   - 403 { reason:'not_owner' } — not the project's owner.
  //   - 409 { reason:'has_tasks' } (or similar) — project is non-empty; the
  //     caller should archive instead.
  //   - 404 — not visible / already gone.
  // Surfaced as STRUCTURED { ok:false, reason } (never throw on these expected
  // codes) so the confirm dialog can show "this project has tasks — archive
  // it instead?" rather than crashing.
  async deleteProject(
    id: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
    const res = await this.request(
      'DELETE',
      `/chromeext/projects/${encodeURIComponent(id)}`,
    );
    if (res.status === 200 || res.status === 204) {
      await res.json().catch(() => ({}));
      return { ok: true };
    }
    if (res.status === 403 || res.status === 404 || res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        data.reason ??
        (res.status === 403
          ? 'not_owner'
          : res.status === 409
            ? 'has_tasks'
            : 'not_visible');
      return { ok: false, reason, status: res.status };
    }
    throw new Error(`typebuild: delete project failed (${res.status})`);
  }

  // ─── project folders (task-a9841cfc0e1b — project CRUD UI) ────────────────
  // POST /chromeext/projects/{id}/folders (add) and DELETE .../folders (remove,
  // folder in the body) — mirrors the archive/unarchive single-purpose-verb
  // pattern rather than routing through the generic PATCH (which a sibling
  // task owns for name/description/instructions). Returns the updated project
  // when the server echoes one; otherwise re-fetches it, same fallback
  // setArchived already uses. NON-PHI (a folder path is not patient data);
  // body never logged.
  private async patchFolder(
    id: string,
    folder: string,
    op: 'add' | 'remove',
  ): Promise<Project> {
    const method = op === 'add' ? 'POST' : 'DELETE';
    const res = await this.request(
      method,
      `/chromeext/projects/${encodeURIComponent(id)}/folders`,
      { folder },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      const detail = data.reason ?? data.error ?? '';
      throw new Error(
        `typebuild: ${op} project folder failed (${res.status})${
          detail ? `: ${detail}` : ''
        }`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      project?: ProjectRow;
    };
    if (data.project && data.project.id) {
      return this.mapProjectRow(data.project);
    }
    const fetched = await this.getProject(id);
    if (fetched) return fetched;
    throw new Error(`typebuild: ${op} project folder — project not found after update`);
  }

  /** Attach a folder to a project (server: add_project_folder). */
  addProjectFolder(id: string, folder: string): Promise<Project> {
    return this.patchFolder(id, folder, 'add');
  }

  /** Detach a folder from a project (server: remove_project_folder). */
  removeProjectFolder(id: string, folder: string): Promise<Project> {
    return this.patchFolder(id, folder, 'remove');
  }

  // ─── users registry (fm-j7w0/S4) ─────────────────────────────────────────
  // GET /chromeext/users → { users: [{ principal, email, display_name, ... }] }.
  // Non-PHI (identities, not patient data). The assignee picker fetches this
  // lazily on open. We don't cache aggressively — a per-call fetch is fine
  // (the list is small and rarely changes mid-session).
  async listUsers(): Promise<
    Array<{ principal: string; email?: string | null; display_name?: string | null }>
  > {
    const res = await this.request('GET', '/chromeext/users');
    if (!res.ok) throw new Error(`typebuild: users failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      users?: Array<{
        principal: string;
        email?: string | null;
        display_name?: string | null;
      }>;
    };
    return Array.isArray(data.users) ? data.users : [];
  }

  // ─── per-task audit history (fm-k6wz/S7) ─────────────────────────────────
  // GET /chromeext/audit?task_id=&limit= → { events: [{ user, action, detail,
  // at }] }, newest first (spec §2). Audit actions + actor are NON-PHI (the
  // server never puts the body in `detail`). Memory-only; the detail panel
  // fetches lazily on History expand and holds the rows in component state.
  async getAudit(
    taskId: string,
    limit = 20,
  ): Promise<Array<{ user: string; action: string; detail: string; at: string }>> {
    const params = new URLSearchParams({
      task_id: taskId,
      limit: String(limit),
    });
    const res = await this.request('GET', `/chromeext/audit?${params}`);
    if (!res.ok) throw new Error(`typebuild: audit failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      events?: Array<{
        user?: string;
        action?: string;
        detail?: string;
        at?: string;
      }>;
    };
    return (Array.isArray(data.events) ? data.events : []).map((e) => ({
      user: e.user ?? '',
      action: e.action ?? '',
      detail: e.detail ?? '',
      at: e.at ?? '',
    }));
  }

  // ─── SavedQuery selectors (task-e713f307c422) ────────────────────────────
  // Form fields backed by a live external-API query (docs/saved-queries-design.md).
  // The executor lives server-side; the client reaches it over the same
  // Firebase-authed /chromeext path. execute runs one query on demand; list
  // enumerates approved queries for the Template Editor's source picker.
  //
  // PHI: executed rows' DISPLAY fields may carry PHI — they cross this hop and
  // are held in renderer memory only; never logged here. Only the row `ref`
  // (opaque ids) + a display snapshot are persisted onto a task (as `data`
  // placeholder keys). The SavedQuery list is NON-PHI (name/version/status).

  // POST /chromeext/queries/:id/execute { inputs, version? } →
  //   { rows: [{ ref: {sourceId, entityType, externalId}, ...displayFields }] }
  async executeQuery(
    savedQueryId: string,
    inputs: Record<string, string>,
    version?: number,
  ): Promise<
    Array<{ ref: { sourceId: string; entityType: string; externalId: string } } & Record<string, unknown>>
  > {
    const body: { inputs: Record<string, string>; version?: number } = { inputs };
    if (version != null) body.version = version;
    const res = await this.request(
      'POST',
      `/chromeext/queries/${encodeURIComponent(savedQueryId)}/execute`,
      body,
    );
    if (!res.ok) throw new Error(`typebuild: query execute failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      rows?: Array<{ ref?: { sourceId?: string; entityType?: string; externalId?: string } } & Record<string, unknown>>;
    };
    const rows = Array.isArray(data.rows) ? data.rows : [];
    // Keep only rows carrying a usable ref; a selection with no ref is useless
    // (nothing to thread onto the task). Stamp missing sourceId defensively.
    return rows
      .filter((r) => r && r.ref && typeof r.ref.externalId === 'string')
      .map((r) => ({
        ...r,
        ref: {
          sourceId: r.ref!.sourceId ?? '',
          entityType: r.ref!.entityType ?? '',
          externalId: r.ref!.externalId!,
        },
      }));
  }

  // GET /chromeext/queries?status=approved → { queries: [{ id, name, version,
  //   status, outputSchema?: { ref?: { entityType } } }] }. Public projection —
  //   no code/auth. [] on a parse miss so the picker degrades to "none".
  async listQueries(
    status?: string,
  ): Promise<Array<{ id: string; name: string; version: number; status: string; entityType?: string }>> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.request('GET', `/chromeext/queries${qs}`);
    if (!res.ok) throw new Error(`typebuild: query list failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      queries?: Array<{
        id?: string;
        name?: string;
        version?: number;
        status?: string;
        entityType?: string;
        // The server returns snake_case `output_schema` (app/utils/saved_queries_db.py
        // `_sq_public`); keep the camelCase alias as a defensive fallback.
        output_schema?: { ref?: { entityType?: string } };
        outputSchema?: { ref?: { entityType?: string } };
      }>;
    };
    return (Array.isArray(data.queries) ? data.queries : [])
      .filter((q) => typeof q.id === 'string')
      .map((q) => ({
        id: q.id!,
        name: q.name ?? q.id!,
        version: typeof q.version === 'number' ? q.version : 1,
        status: q.status ?? 'unknown',
        entityType:
          q.entityType ?? q.output_schema?.ref?.entityType ?? q.outputSchema?.ref?.entityType,
      }));
  }

  // ─── SavedQuery authoring (task-d8a0b081eb93) ────────────────────────────
  // Design-time CopilotKit authoring flow (docs/saved-queries-design.md,
  // "Authoring flow (CopilotKit)" + Addendum §1). The admin describes a need in
  // chat; Copilot — grounded with the DataSource spec (listDataSources below) —
  // drafts the query code + outputSchema, the draft is created (createQuery),
  // and a MANDATORY human approve gate (approveQuery) flips it draft→approved,
  // which ALSO publishes it org-wide (approval == publish). These mirror the
  // execute/list pair above: same Firebase-authed /chromeext path, same request().
  //
  // Server response keys are snake_case (app/utils/saved_queries_db.py
  // `_sq_public` / `_ds_public`): output_schema, source_id, base_url,
  // entity_types, approved_by, group_id, project_id. We accept snake_case first
  // and keep camelCase aliases as a defensive fallback. Query CODE + SCHEMA are
  // NON-PHI author config (safe to hold/return); DataSource carries NO creds.

  // GET /chromeext/datasources → { datasources: [{ id, name, base_url,
  //   entity_types }] }. The "API spec" grounding context for the LLM — name +
  //   base_url + entity_types, never auth (stripped server-side by _ds_public).
  async listDataSources(): Promise<
    Array<{ id: string; name: string; baseUrl: string; entityTypes: string[] }>
  > {
    const res = await this.request('GET', '/chromeext/datasources');
    if (!res.ok) throw new Error(`typebuild: datasource list failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as {
      // The server envelope is snake_case `data_sources` (app/routers/
      // saved_queries.py); keep `datasources` as a defensive fallback.
      data_sources?: Array<Record<string, unknown>>;
      datasources?: Array<{
        id?: string;
        name?: string;
        base_url?: string;
        baseUrl?: string;
        entity_types?: string[];
        entityTypes?: string[];
      }>;
    };
    const list = (Array.isArray(data.data_sources) ? data.data_sources : data.datasources) as
      | Array<{
          id?: string;
          name?: string;
          base_url?: string;
          baseUrl?: string;
          entity_types?: string[];
          entityTypes?: string[];
        }>
      | undefined;
    return (Array.isArray(list) ? list : [])
      .filter((d) => typeof d.id === 'string')
      .map((d) => ({
        id: d.id!,
        name: d.name ?? d.id!,
        baseUrl: d.base_url ?? d.baseUrl ?? '',
        entityTypes: Array.isArray(d.entity_types)
          ? d.entity_types
          : Array.isArray(d.entityTypes)
            ? d.entityTypes
            : [],
      }));
  }

  // POST /chromeext/queries { name, source_id, inputs, code, output_schema,
  //   limits, project_id?, group_id? } → the new DRAFT query dict (v1). Returns
  //   the id + version so Copilot can chain test/approve.
  async createQuery(input: {
    name: string;
    sourceId: string;
    code: string;
    outputSchema: unknown;
    inputs?: unknown;
    limits?: unknown;
    projectId?: string;
    groupId?: string;
  }): Promise<{ id: string; name: string; version: number; status: string }> {
    const body: Record<string, unknown> = {
      name: input.name,
      source_id: input.sourceId,
      inputs: input.inputs ?? {},
      code: input.code,
      output_schema: input.outputSchema,
      limits: input.limits ?? {},
    };
    if (input.projectId) body.project_id = input.projectId;
    if (input.groupId) body.group_id = input.groupId;
    const res = await this.request('POST', '/chromeext/queries', body);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`typebuild: query create failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    // The server wraps the record as { ok, id, query: {...} } (POST /queries);
    // unwrap `.query`, falling back to the top level for resilience.
    const payload = (await res.json().catch(() => ({}))) as { query?: unknown } & Record<string, unknown>;
    const q = ((payload.query as Record<string, unknown> | undefined) ?? payload) as {
      id?: string;
      name?: string;
      version?: number;
      status?: string;
    };
    if (!q.id) throw new Error('typebuild: query create returned no id');
    return {
      id: q.id,
      name: q.name ?? q.id,
      version: typeof q.version === 'number' ? q.version : 1,
      status: q.status ?? 'draft',
    };
  }

  // GET /chromeext/queries/:id → the query dict (public projection: code +
  //   output_schema + status, no auth). Used to show the code/schema in the
  //   approve card so the human sees exactly what they are approving.
  async getQuery(savedQueryId: string): Promise<{
    id: string;
    name: string;
    version: number;
    status: string;
    sourceId: string;
    code: string;
    outputSchema: unknown;
  }> {
    const res = await this.request(
      'GET',
      `/chromeext/queries/${encodeURIComponent(savedQueryId)}`,
    );
    if (!res.ok) throw new Error(`typebuild: query get failed (${res.status})`);
    // Server returns { query: {...} } (GET /queries/:id); unwrap with fallback.
    const payload = (await res.json().catch(() => ({}))) as { query?: unknown } & Record<string, unknown>;
    const q = ((payload.query as Record<string, unknown> | undefined) ?? payload) as {
      id?: string;
      name?: string;
      version?: number;
      status?: string;
      source_id?: string;
      sourceId?: string;
      code?: string;
      output_schema?: unknown;
      outputSchema?: unknown;
    };
    if (!q.id) throw new Error('typebuild: query get returned no id');
    return {
      id: q.id,
      name: q.name ?? q.id,
      version: typeof q.version === 'number' ? q.version : 1,
      status: q.status ?? 'unknown',
      sourceId: q.source_id ?? q.sourceId ?? '',
      code: q.code ?? '',
      outputSchema: q.output_schema ?? q.outputSchema ?? {},
    };
  }

  // POST /chromeext/queries/:id/approve → draft→approved, approved_by=caller.
  //   THE human gate; also the publish step (approval makes the version
  //   org-visible per Addendum §1). Returns the updated query dict.
  async approveQuery(
    savedQueryId: string,
  ): Promise<{ id: string; name: string; version: number; status: string; approvedBy?: string }> {
    const res = await this.request(
      'POST',
      `/chromeext/queries/${encodeURIComponent(savedQueryId)}/approve`,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`typebuild: query approve failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    // Server returns { ok, query: {...} } (POST /approve); unwrap with fallback.
    const payload = (await res.json().catch(() => ({}))) as { query?: unknown } & Record<string, unknown>;
    const q = ((payload.query as Record<string, unknown> | undefined) ?? payload) as {
      id?: string;
      name?: string;
      version?: number;
      status?: string;
      approved_by?: string;
      approvedBy?: string;
    };
    return {
      id: q.id ?? savedQueryId,
      name: q.name ?? (q.id ?? savedQueryId),
      version: typeof q.version === 'number' ? q.version : 1,
      status: q.status ?? 'approved',
      approvedBy: q.approved_by ?? q.approvedBy,
    };
  }

  // POST /chromeext/queries/:id/version → clone the current version to a NEW
  //   draft (v+1) for iterate-in-chat. Body may carry the edited fields; server
  //   defaults to a clone when omitted. Returns the new draft's id/version.
  async newQueryVersion(
    savedQueryId: string,
    patch?: { code?: string; outputSchema?: unknown; inputs?: unknown; limits?: unknown },
  ): Promise<{ id: string; name: string; version: number; status: string }> {
    const body: Record<string, unknown> = {};
    if (patch?.code !== undefined) body.code = patch.code;
    if (patch?.outputSchema !== undefined) body.output_schema = patch.outputSchema;
    if (patch?.inputs !== undefined) body.inputs = patch.inputs;
    if (patch?.limits !== undefined) body.limits = patch.limits;
    const res = await this.request(
      'POST',
      `/chromeext/queries/${encodeURIComponent(savedQueryId)}/version`,
      body,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`typebuild: query version failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    // Server returns { ok, id, query: {...} } (POST /version); unwrap with fallback.
    const payload = (await res.json().catch(() => ({}))) as { query?: unknown } & Record<string, unknown>;
    const q = ((payload.query as Record<string, unknown> | undefined) ?? payload) as {
      id?: string;
      name?: string;
      version?: number;
      status?: string;
    };
    return {
      id: q.id ?? savedQueryId,
      name: q.name ?? (q.id ?? savedQueryId),
      version: typeof q.version === 'number' ? q.version : 1,
      status: q.status ?? 'draft',
    };
  }

  // ─── FormExtensions (task-ae0ec0348930) ──────────────────────────────────
  // The CLIENT half of the FormExtension primitive (docs/saved-queries-design.md
  // family). A FormExtension is an approved, versioned bundle of extra form
  // FIELDS (widget descriptors the client renders with its OWN trusted widgets)
  // + a PURE server-side LOGIC function that, on any field change, returns a
  // small allowlisted `effects` object the client APPLIES declaratively. The
  // client never eval's the logic and never injects markup — the security point
  // of the whole primitive is that logic runs server-side and the client only
  // switches on a fixed set of effect keys.
  //
  // Endpoints (all /chromeext/, Firebase-authed, snake_case envelopes — the
  // record nests under `form_extension`, lists under `form_extensions`; mirrors
  // the corrected queries unwrap pattern above):
  //   GET  /chromeext/form-extensions?status=  → { form_extensions: [...] }
  //   POST /chromeext/form-extensions          → { ok, id, form_extension }
  //   GET  /chromeext/form-extensions/:id       → { form_extension }
  //   POST /chromeext/form-extensions/:id/version → { ok, id, form_extension }
  //   POST /chromeext/form-extensions/:id/approve → { ok, form_extension }
  //   POST /chromeext/form-extensions/:id/disable → { ok, form_extension }
  //   POST /chromeext/form-extensions/:id/run-logic { values, changed }
  //       → { ok, effects, version }
  //
  // PHI: form field VALUES the human/agent fills may carry PHI. They cross the
  // run-logic hop (server needs them to compute effects) but are held in
  // renderer memory only — never logged here. The FormExtension config itself
  // (fields/logic/applies_to) is NON-PHI author config.

  // Normalize a raw server form-extension record → the client-facing shape. The
  // top level is snake_case (id/family_id/applies_to/project_id/group_id/…);
  // `fields[]` elements use camelCase INSIDE `source` (savedQueryId) mirroring
  // TemplateField.source. Defensive: a non-object or a row missing an id yields
  // null so a malformed entry is dropped rather than reaching the renderer.
  private mapFormExtensionRow(raw: unknown): {
    id: string;
    familyId: string | null;
    name: string;
    version: number;
    status: string;
    approvedBy: string | null;
    appliesTo: Record<string, unknown>;
    fields: Array<Record<string, unknown>>;
    logic: string;
    limits: Record<string, unknown>;
    projectId: string | null;
    groupId: string | null;
  } | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!id) return null;
    return {
      id,
      familyId: typeof r.family_id === 'string' ? r.family_id : null,
      name: typeof r.name === 'string' ? r.name : id,
      version: typeof r.version === 'number' ? r.version : 1,
      status: typeof r.status === 'string' ? r.status : 'draft',
      approvedBy: typeof r.approved_by === 'string' ? r.approved_by : null,
      appliesTo:
        r.applies_to && typeof r.applies_to === 'object'
          ? (r.applies_to as Record<string, unknown>)
          : {},
      fields: Array.isArray(r.fields)
        ? (r.fields.filter((f) => f && typeof f === 'object') as Array<Record<string, unknown>>)
        : [],
      logic: typeof r.logic === 'string' ? r.logic : '',
      limits:
        r.limits && typeof r.limits === 'object' ? (r.limits as Record<string, unknown>) : {},
      projectId: typeof r.project_id === 'string' ? r.project_id : null,
      groupId: typeof r.group_id === 'string' ? r.group_id : null,
    };
  }

  // Unwrap a mutating endpoint's { ok, [id], form_extension: {...} } envelope,
  // falling back to the top level for resilience (same pattern as the queries
  // `.query` unwrap). Throws when no usable record is present.
  private unwrapFormExtension(payload: unknown, verb: string) {
    const p = (payload ?? {}) as { form_extension?: unknown } & Record<string, unknown>;
    const mapped = this.mapFormExtensionRow(p.form_extension ?? p);
    if (!mapped) throw new Error(`typebuild: form-extension ${verb} returned no record`);
    return mapped;
  }

  // GET /chromeext/form-extensions?status= → { form_extensions: [...] }. Public
  // projection. Returns [] on a parse miss so the caller degrades to "none".
  async listFormExtensions(status?: string) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.request('GET', `/chromeext/form-extensions${qs}`);
    if (!res.ok) throw new Error(`typebuild: form-extension list failed (${res.status})`);
    const data = (await res.json().catch(() => ({}))) as { form_extensions?: unknown[] };
    const list = Array.isArray(data.form_extensions) ? data.form_extensions : [];
    return list
      .map((r) => this.mapFormExtensionRow(r))
      .filter((r): r is NonNullable<ReturnType<typeof this.mapFormExtensionRow>> => r !== null);
  }

  // POST /chromeext/form-extensions { name, applies_to, fields, logic, limits?,
  //   project_id?, group_id? } → { ok, id, form_extension }. Creates a DRAFT.
  async createFormExtension(input: {
    name: string;
    appliesTo: Record<string, unknown>;
    fields: Array<Record<string, unknown>>;
    logic: string;
    limits?: Record<string, unknown>;
    projectId?: string;
    groupId?: string;
  }) {
    const body: Record<string, unknown> = {
      name: input.name,
      applies_to: input.appliesTo ?? {},
      fields: input.fields ?? [],
      logic: input.logic ?? '',
    };
    if (input.limits) body.limits = input.limits;
    if (input.projectId) body.project_id = input.projectId;
    if (input.groupId) body.group_id = input.groupId;
    const res = await this.request('POST', '/chromeext/form-extensions', body);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `typebuild: form-extension create failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    const payload = (await res.json().catch(() => ({}))) as unknown;
    return this.unwrapFormExtension(payload, 'create');
  }

  // GET /chromeext/form-extensions/:id → { form_extension }. Used to show the
  // fields + logic in the approve card so the human sees what they approve.
  async getFormExtension(id: string) {
    const res = await this.request(
      'GET',
      `/chromeext/form-extensions/${encodeURIComponent(id)}`,
    );
    if (!res.ok) throw new Error(`typebuild: form-extension get failed (${res.status})`);
    const payload = (await res.json().catch(() => ({}))) as unknown;
    return this.unwrapFormExtension(payload, 'get');
  }

  // POST /chromeext/form-extensions/:id/approve → { ok, form_extension }. THE
  // human design-time gate (draft→approved). Called only from the mandatory
  // confirmedAction card, never auto.
  async approveFormExtension(id: string) {
    const res = await this.request(
      'POST',
      `/chromeext/form-extensions/${encodeURIComponent(id)}/approve`,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `typebuild: form-extension approve failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    const payload = (await res.json().catch(() => ({}))) as unknown;
    return this.unwrapFormExtension(payload, 'approve');
  }

  // POST /chromeext/form-extensions/:id/version → { ok, id, form_extension }.
  // Clones the current version to a NEW draft (v+1) for iterate-in-chat. Body
  // may carry edited fields; server defaults to a clone when omitted.
  async newFormExtensionVersion(
    id: string,
    patch?: {
      fields?: Array<Record<string, unknown>>;
      logic?: string;
      appliesTo?: Record<string, unknown>;
      limits?: Record<string, unknown>;
    },
  ) {
    const body: Record<string, unknown> = {};
    if (patch?.fields !== undefined) body.fields = patch.fields;
    if (patch?.logic !== undefined) body.logic = patch.logic;
    if (patch?.appliesTo !== undefined) body.applies_to = patch.appliesTo;
    if (patch?.limits !== undefined) body.limits = patch.limits;
    const res = await this.request(
      'POST',
      `/chromeext/form-extensions/${encodeURIComponent(id)}/version`,
      body,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `typebuild: form-extension version failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    const payload = (await res.json().catch(() => ({}))) as unknown;
    return this.unwrapFormExtension(payload, 'version');
  }

  // POST /chromeext/form-extensions/:id/run-logic { values, changed } →
  //   { ok, effects: {...}, version }. Runs the PURE server-side logic function
  //   and returns the allowlisted effects the client applies. `values` is the
  //   full current field-value map (may carry PHI — memory-only, never logged);
  //   `changed` is the key that just changed (or null on an initial pass). The
  //   server already allowlist-strips effects to the four keys; we pass `effects`
  //   through as an opaque object and let the client's reducer double-guard.
  async runFormLogic(
    id: string,
    values: Record<string, unknown>,
    changed: string | null,
  ): Promise<{ effects: Record<string, unknown>; version: number }> {
    const res = await this.request(
      'POST',
      `/chromeext/form-extensions/${encodeURIComponent(id)}/run-logic`,
      { values: values ?? {}, changed: changed ?? null },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `typebuild: form-extension run-logic failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      effects?: unknown;
      version?: unknown;
    };
    return {
      effects:
        data.effects && typeof data.effects === 'object'
          ? (data.effects as Record<string, unknown>)
          : {},
      version: typeof data.version === 'number' ? data.version : 0,
    };
  }

  // ─── runNow / Start (fm-b5at.5, MCP auth handoff fm-b5at.9) ──────────────
  // "Start" launches an INTERACTIVE embedded-terminal claude session, pre-
  // wired to this task AND pre-authenticated. The user never types a command
  // and never sees an MCP sign-in prompt.
  //
  // Flow:
  //   1. MINT FIRST (fm-b5at.9): exchange the Firebase ID token for a fresh,
  //      short-lived MCP JWT. This GATES the spawn — the mint doubles as a
  //      reachability + identity preflight. On a typed failure we throw the
  //      structured code; the renderer maps it to one of three in-app messages
  //      and NO terminal opens. With a static Authorization header there is no
  //      in-session OAuth fallback, so a failed mint MUST stop us here.
  //   2. Spawn claude interactively with:
  //        - the minted token in the PTY ENV (TYPEBUILD_MCP_TOKEN) — never in
  //          argv (/proc/<pid>/cmdline is world-readable).
  //        - --strict-mcp-config --mcp-config <inline JSON> referencing the
  //          env var (not the literal token). claude expands ${VAR} from the
  //          spawned env into the Authorization header → already authenticated.
  //        - prompt: "Run /typebuild:typebuild-work and claim task <id>"
  //          (ONLY the opaque task id — no PHI). task-8997b15a37d9: this is a
  //          PLUGIN SKILL (typebuild-plugin repo, skills/typebuild-work/SKILL.md),
  //          invoked by its fully-qualified `<plugin>:<skill-dir>` name — NOT an
  //          MCP prompt. The old `/mcp__typebuild__work` reference errored
  //          "Unknown skill" every launch because that double-underscore form is
  //          MCP-prompt syntax, and the typebuild MCP server exposes no `work`
  //          prompt; the actual `/work` entry point is this skill.
  //        - args derived from the server `flags` (chrome → --chrome, etc.).
  //        - cwd: the home directory (folder hints are a later follow-up).
  //   3. NO local task_runs row — task_runs.task_id FKs the local `tasks`
  //      table and a remote id has no local row (recordRun:false).
  //   4. The tab label is GENERIC ("TypeBuild task <shortid>") — the title
  //      is PHI and the renderer can surface tab labels.
  //   5. Register the session (ptyId → token expiry + taskId) so the expiry
  //      clock (fm-b5at.10) can warn before the token lapses; clear on exit.
  //   6. Start = CLAIM-THEN-LAUNCH (fm-v0rc, Phase B3). We claim over REST
  //      FIRST so the row flips to "claimed by me" instantly and a contested
  //      task is rejected before any terminal opens. The in-session MCP claim
  //      is conditional on status=open (typebuild.ts:374-377) — once we hold
  //      the claim, status is no longer 'open', so the spawned session must
  //      NOT re-claim (it would 409). The preclaimed prompt tells the agent
  //      to skip the claim and just run /work for the id.
  //   7. After the PTY exits: refresh + broadcast; if the task is still
  //      claimed by THIS principal, broadcast a Release prompt.
  async runNow(id: string, _opts?: RunNowOptions): Promise<unknown> {
    const me = getAuthState().email ?? null;
    const cached = this.cache.get(id);
    // Fast-path: contested by someone else → reject inline, no network call.
    if (cached?.claimedBy && cached.claimedBy !== me) {
      return {
        ok: false,
        reason: 'already claimed',
        claimedBy: cached.claimedBy,
      };
    }

    // Claim over REST unless I already hold it. claim() returns a structured
    // { ok:false, ... } on 409/404 (someone raced us / not visible); propagate
    // that so the renderer shows the same friendly inline message.
    const alreadyMine = !!me && cached?.claimedBy === me;
    if (!alreadyMine) {
      const claimed = (await this.claim(id)) as { ok?: boolean };
      if (!claimed?.ok) return claimed;
    }

    // We hold the claim now (either freshly or from before). Launch the
    // session pre-claimed so it does NOT re-claim.
    try {
      const res = await this.launchSession(id, { resume: false, preclaimed: true });
      // task-3f0c6a6abe41 — launchSession only returns after res.launched was
      // verified true and a real ptyId was assigned; a 0/absent ptyId here
      // would mean "claimed but no session", the exact phantom we must never
      // return as ok. Guard it explicitly.
      if (!res.ptyId) {
        throw new Error('[typebuild-launch:no-pty] launch returned no session id');
      }
      return { ok: true, ptyId: res.ptyId };
    } catch (err) {
      // task-3f0c6a6abe41 — the mint/spawn threw AFTER we just claimed in THIS
      // call. LOG the real, token-free reason (afffda8's renderer-side catch
      // used to swallow it) so the actual launch failure is diagnosable, then
      // rethrow so the renderer maps the typed reason onto the row. PHI-free:
      // the error carries only the opaque task id + a machine reason code.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[typebuild] launch failed for task ${id}: ${reason}`);
      throw err;
    }
  }

  // ─── expiry relaunch (fm-b5at.10) ────────────────────────────────────────
  // The MCP JWT lives ~8h and CANNOT refresh mid-session (static header). When
  // it lapses, the live PTY's MCP server goes dead with an opaque in-terminal
  // error. The expiry clock (electron/typebuild/expiry-clock.ts) catches this
  // BEFORE the user hits it and offers a one-click "restart task". This is that
  // restart: gracefully kill the old (expired) PTY, mint a FRESH token, and
  // respawn with the resume flag (--continue) so the SAME conversation
  // continues — now re-authenticated. Mint failures gate the relaunch exactly
  // as the initial launch does (same typed codes → same three in-app
  // messages, no dead terminal). The renderer repoints the existing tab onto
  // the new ptyId (no tab churn). Known v1 caveat: --continue resumes the most
  // recent conversation in the cwd (home) — there is no per-session id to pin
  // to in interactive mode, so a second TypeBuild session opened in home since
  // could be the one resumed. Acceptable for v1.
  async relaunchSession(oldPtyId: number, taskId: string): Promise<unknown> {
    // Retire the old PTY first. Killing it fires its onExit (clearSession +
    // the release/refresh flow); we tolerate it being already gone (the token
    // may have died and the user closed the tab). Import lazily to avoid a
    // main-startup import cycle (ipc.ts ⇄ sources).
    const { killManagedPty } = await import('../ipc');
    // Mark BEFORE the kill so the old PTY's onExit (which fires after kill)
    // sees the flag and suppresses the spurious release prompt. Consumed by
    // onSessionExit. If the mint below fails the session truly ends, so we
    // re-allow the prompt in the catch.
    this.relaunching.add(taskId);
    killManagedPty(oldPtyId);

    // Respawn resumed. A fresh mint gates this just like the initial launch.
    let res: { ptyId: number };
    try {
      res = await this.launchSession(taskId, { resume: true });
    } catch (err) {
      // Relaunch failed (e.g. mint error). The old PTY is already dead; let a
      // future genuine exit prompt for release again, and propagate the typed
      // error so the renderer shows the right in-app message.
      this.relaunching.delete(taskId);
      throw err;
    }

    // Tell the renderer to repoint the tab that hosted oldPtyId onto the new
    // ptyId — avoids closing/reopening a tab under the user. PHI-free payload.
    for (const w of browserWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('typebuild:sessionRelaunched', {
          oldPtyId,
          newPtyId: res.ptyId,
          cwd: os.homedir(),
          title: `TypeBuild task ${shortId(taskId)}`,
        });
      }
    }
    return { ok: true, ptyId: res.ptyId };
  }

  // Shared launch core for both the initial Start (runNow) and the expiry
  // relaunch. `resume` adds the `resume` flag → claude --continue and drops
  // the positional /work-claim prompt (a resumed conversation already claimed
  // the task; re-prompting would re-run the claim). Returns the live run
  // result; throws (typed mint error / no-window) on failure so callers and
  // the IPC layer surface the same in-app messages.
  private async launchSession(
    id: string,
    opts: { resume: boolean; preclaimed?: boolean },
  ): Promise<{ ptyId: number }> {
    // Routing fields (flags) come from the in-memory cache populated by the
    // list poll; fall back to an empty flag set if the row isn't cached yet.
    const cached = this.cache.get(id);
    const serverFlags = cached?.flags ?? [];

    // 1. Mint the MCP token FIRST — success gates the spawn. mintMcpToken
    //    throws a typed McpTokenError ({code}) on failure; we let it propagate
    //    so the IPC layer carries the code to the renderer, which maps it to
    //    the right in-app message. No terminal opens on a thrown mint.
    const minted = await mintMcpToken();

    // Force the interactive run style; pass through the server's arg-producing
    // flags. 'interactive' is a no-op for flagsToArgs but documents intent;
    // runTaskInteractive ignores it for arg purposes. On a relaunch we add
    // 'resume' (→ --continue) so the prior conversation continues with the
    // fresh token instead of starting cold.
    //
    // SPIKE (spike/playwright-cdp): drive the EMBEDDED Breeze browser tab via
    // Playwright over CDP instead of the Claude-in-Chrome extension. 'playwright'
    // is forced on (the in-app analog of the old forced 'chrome'): the launcher
    // opens a browser tab, points the agent at the helper CLI, and pre-grants
    // its permission (see ensureTasksWorkspace). We strip any server-sent
    // 'chrome' so the two browser integrations never both load. The Set dedupes.
    // 'auto' is forced on alongside 'playwright': every browser task launches in
    // the classifier-driven auto permission mode (flags.ts → --permission-mode
    // auto) so the agent's Bash driver/tool CLI calls run unattended instead of
    // prompting on each one. The mode still pauses on risky/irreversible actions
    // and never bypasses the human-gated final submit.
    const flags = Array.from(
      new Set([
        ...serverFlags.filter((f) => f !== 'chrome'),
        'interactive',
        'playwright',
        'auto',
        ...(opts.resume ? ['resume'] : []),
      ]),
    );

    const { runTaskInteractive } = await import('../agents/interactive');
    // task-3f0c6a6abe41 — hand the launcher a DETERMINISTIC, live MAIN window
    // (never the operator window, never a window mid-teardown). Without this,
    // a gesture-less auto-continue tick — which fires right after the previous
    // step's operator window closed, so there's no focused window — let
    // runTaskInteractive fall back to `getAllWindows().find()`, which could
    // pick a dead/operator webContents; binding the pty to it threw before the
    // spawn (claim held, no claude process). null here → runTaskInteractive's
    // own hostable-window fallback still runs (and fails loudly, not silently).
    const { getPrimaryHostWindow } = await import('../browser/window');
    const hostWindow = getPrimaryHostWindow() ?? undefined;
    const synthetic: Task = this.syntheticTask(id, flags);

    // App-owned workspace + permission grant (see ensureTasksWorkspace). The
    // session runs here and loads the seeded settings via --settings below.
    const { cwd: tasksCwd, settingsPath } = ensureTasksWorkspace();

    // task-7bc1f1dfc202 — server-hosted operator instructions. Lead with the ONE
    // GLOBAL doc (scope=global): fetch it at session start and append it as a
    // system-prompt addendum so it layers onto BOTH delivery paths (workspace
    // CLAUDE.md and project-folder prompt) uniformly. The fetch caches on disk and
    // falls back to that cache offline; an unset/empty doc yields '' and we simply
    // inject nothing (the bundled playbook still rides the workspace CLAUDE.md /
    // prompt addendum). NON-PHI standing guidance — never a value; never logged.
    // Defensive: any failure leaves operatorInstructions empty so the launch
    // proceeds on the bundled default.
    let operatorInstructions = '';
    try {
      const { fetchOperatorInstructions } = await import('../typebuild/operator-instructions');
      const oi = await fetchOperatorInstructions('global');
      operatorInstructions = oi.body.trim();
    } catch {
      /* server-hosted instructions are additive — never block a launch on them */
    }

    // task-9bd1389e64c6 — pre-fetched task-context bundle. ONE GET pulls the
    // server-prepared (async-at-create, server-cached) bundle of RELEVANT SITES
    // for this task + their associated memories + any task-level recall, rendered
    // as NON-PHI Markdown. We inject it as a system-prompt addendum (same seam as
    // operator-instructions) so the agent has all standing context in its FIRST
    // turn and makes ZERO extra recall_site/recall_task discovery round-trips
    // before acting. Empty when the server has no bundle yet (404), detection is
    // still running (ready:false), or the fetch failed — the launch always
    // proceeds; the agent falls back to live discovery. NON-PHI by contract (the
    // task body is never part of the bundle); body never logged. On a relaunch we
    // skip it: --continue resumes a conversation that already has this context, so
    // re-injecting would duplicate it. Disk-cached for offline launches.
    let contextBundleAddendum = '';
    if (!opts.resume) {
      try {
        const { fetchTaskContextBundle, renderBundleAddendum } = await import(
          '../typebuild/task-context-bundle'
        );
        const bundle = await fetchTaskContextBundle(id);
        contextBundleAddendum = renderBundleAddendum(bundle);
      } catch {
        /* the bundle is additive — never block a launch on it */
      }
    }

    // task-ab1d7955e23f (item 4) — project-derived launch context. When the
    // task belongs to a TypeBuild project, run it IN the project's folder and
    // inject the project's cascading instructions into the session. Resolved
    // with effective=1 so we get the merged (parent → child) instructions.
    // Defensive: a null/folderless project, a missing folder, or any resolve
    // error falls back to the generic tasks workspace and an instruction-free
    // prompt — the session still launches. Project name/instructions/folders
    // are NON-PHI teaching context; the task title/body are never touched here.
    const projectCtx = await this.resolveLaunchContext(id);
    const runCwd = projectCtx.cwd ?? tasksCwd;

    // Pre-claimed Start (fm-v0rc): we already hold the claim over REST, so the
    // session must NOT re-claim (the in-session claim is conditional on
    // status=open and would 409 now). Tell the agent the task is already mine
    // and to run /work without claiming. ONLY the opaque task id — no PHI.
    const basePrompt = opts.preclaimed
      ? `Task ${id} is already claimed by me. Run /typebuild:typebuild-work for task ${id} — do not claim it again.`
      : `Run /typebuild:typebuild-work and claim task ${id}`;
    // Prepend the project's effective instructions (NON-PHI) as context so the
    // agent operates with the project's cascading guidance from the first turn.
    const withInstructions = projectCtx.instructions
      ? `${projectCtx.instructions}\n\n---\n\n${basePrompt}`
      : basePrompt;
    // The browser playbook normally rides the workspace CLAUDE.md (seeded in
    // ensureTasksWorkspace, auto-loaded from cwd=TASKS_DIR). But a project task
    // runs in the user's OWN folder (projectCtx.cwd), where that CLAUDE.md is
    // out of scope and we won't write one into their repo — so fall back to
    // carrying the playbook in the prompt for that case only.
    const prompt =
      projectCtx.cwd && !opts.resume
        ? `${withInstructions}\n${playwrightPromptAddendum()}`
        : withInstructions;

    // task-bd35fc4330c0 — pre-assembled task-work bundle (title + full body +
    // resolved input values + output schema/evidence + project instructions +
    // attached skills), delivered as the agent's FIRST message over STDIN (see
    // electron/agents/interactive.ts injectWorkBundle / electron/typebuild/
    // task-work-bundle.ts). Goal: the agent's FIRST tool call is task WORK, not
    // get_task. Skipped on resume — --continue already has this context from
    // the original launch; re-injecting would duplicate it in the transcript.
    //
    // FRESHNESS: fetched/resolved HERE, at launch time — not from any earlier
    // cache — so the body/values reflect the current claim-holder's read
    // (per the task spec). Fully defensive/best-effort: ANY failure (network,
    // 404, resolve error) degrades to workBundle:'' and the launch proceeds on
    // the existing /work-claim fallback prompt exactly as before this change
    // (NON-REGRESSION) — the agent just falls back to calling get_task itself.
    //
    // PHI: the fetched body + resolved values NEVER touch argv/disk/the
    // --append-system-prompt strings above. They live in this function's stack
    // only, on the way into runTaskInteractive's workBundle option, which
    // writes them straight into the pty's stdin fd.
    let workBundle = '';
    if (!opts.resume) {
      try {
        const { resolveTaskDataRef } = await import('../typebuild/task-data');
        const { buildTaskWorkBundle } = await import('../typebuild/task-work-bundle');
        const detail = await this.getTask(id);
        if (detail) {
          const dataKeys = detail.dataKeys ?? [];
          const resolvedInputs: { key: string; value: string }[] = [];
          for (const key of dataKeys) {
            try {
              const value = await resolveTaskDataRef(id, key);
              resolvedInputs.push({ key, value });
            } catch {
              // Unresolved key — bundle renders it as "(unresolved)" rather
              // than silently omitting it; never blocks the rest of the launch.
            }
          }
          const rawSkills = (detail as unknown as { skills?: unknown }).skills;
          workBundle = buildTaskWorkBundle(
            {
              id,
              title: detail.title,
              body: detail.notes ?? null,
              dataKeys,
              outputSchema: detail.outputSchema,
              projectInstructions: projectCtx.instructions,
              skills: rawSkills,
              preclaimed: opts.preclaimed,
            },
            resolvedInputs,
          );
        }
      } catch {
        /* best-effort — the /work-claim prompt fallback still runs the task */
      }
    }

    let ptyId = 0;
    const res = await runTaskInteractive(synthetic, {
      agentId: 'claude',
      // task-3f0c6a6abe41 — the resolved live MAIN window (see above). undefined
      // falls through to runTaskInteractive's own hostable-window resolution.
      window: hostWindow,
      // ONLY the opaque task id — never a title/body (PHI). This positional
      // prompt (→ argv) stays SHORT and content-free; the actual task content
      // rides workBundle over stdin instead (task-bd35fc4330c0).
      prompt,
      // task-bd35fc4330c0 — the pre-assembled bundle, injected over stdin once
      // the session proves alive. '' when the fetch/resolve above didn't run
      // or failed — runTaskInteractive's injectWorkBundle no-ops on empty.
      workBundle,
      // On resume, suppress the positional prompt so --continue resumes the
      // existing conversation rather than seeding a new /work claim.
      omitPrompt: opts.resume,
      // Project folder when the task belongs to a project (resolveLaunchContext),
      // else the generic app-owned tasks workspace.
      cwd: runCwd,
      // No local run row: FK to tasks(id) would fail for a remote id.
      recordRun: false,
      // task-6fc9e503623e — LIVENESS GATE. Don't return "started" until the
      // claude child has proven it stays up (survives ~5s or prints first
      // output). An instantly-dying auto-continue session is caught below and
      // turned into a loud, recorded failure instead of a phantom running row.
      awaitLiveness: { minAliveMs: 5000 },
      // PHI: generic, content-free tab label.
      label: `TypeBuild task ${shortId(id)}`,
      source: this.id,
      // --settings: load the seeded permission grant explicitly (so it applies
      // without depending on the cwd being "trusted"). It pre-approves the
      // typebuild + claude-in-chrome MCP tools so /work runs end-to-end without
      // stalling on a per-tool permission prompt the user never sees coming.
      // --strict-mcp-config: load ONLY our inline server (header-injected),
      // ignoring user/project scope and avoiding a name collision with the
      // plugin's header-free .mcp.json. The inline config holds the ${VAR}
      // reference, NOT the secret.
      extraArgs: [
        '--settings', settingsPath,
        // Browser tasks run on Sonnet (claude-sonnet-5): fast/cheap enough for
        // portal driving, capable enough for the operator playbook. Explicit
        // per-launch override so the user's global default model isn't burned
        // on routine browser work.
        '--model', 'claude-sonnet-5',
        '--strict-mcp-config', '--mcp-config', MCP_INLINE_CONFIG,
        // task-7bc1f1dfc202 — the GLOBAL server-hosted operator instructions,
        // layered on as a system-prompt addendum. Omitted entirely when the doc
        // is unset/empty or the fetch failed (bundled playbook still applies).
        ...(operatorInstructions
          ? ['--append-system-prompt', operatorInstructions]
          : []),
        // task-9bd1389e64c6 — the pre-fetched relevant-sites + memories bundle,
        // layered on as its OWN system-prompt addendum so the agent starts with
        // all standing context and skips the discovery round-trips. Omitted when
        // there is no ready bundle (or on a resume).
        ...(contextBundleAddendum
          ? ['--append-system-prompt', contextBundleAddendum]
          : []),
      ],
      env: {
        // The minted token, PTY env only. claude expands ${TYPEBUILD_MCP_TOKEN}
        // from here into the Authorization header. Never logged/persisted.
        [MCP_TOKEN_ENV]: minted.accessToken,
        // PHI-free marker so the renderer can gate TypeBuild-tab behavior.
        BREEZE_TYPEBUILD_TASK: '1',
        // Cooperative-boundary PII/data injection (docs/pii-data-injection-design.md).
        // The opaque task id (non-PHI) lets the browser helper's `fill-ref` ask
        // Breeze main to resolve a `data` placeholder for THIS task. Env only —
        // never argv (/proc/<pid>/cmdline is world-readable); never a title/body.
        BREEZE_TYPEBUILD_TASK_ID: id,
      },
      onExit: () => {
        // Drop the session from the expiry registry, then run the
        // refresh/release-prompt flow. `ptyId` is assigned synchronously
        // below before any exit can fire.
        clearSession(ptyId);
        void this.onSessionExit(id);
      },
    });

    if (!res.launched) {
      // No GUI window to host the tab — interactive Start needs the app open
      // (with a live window). task-3f0c6a6abe41 — tag the reason so the
      // renderer can show the REAL cause on the row instead of a generic
      // "start failed". IPC strips custom Error props, so it rides in the
      // message with a stable, machine-parsable prefix (mirrors mint-token.ts).
      throw new Error('[typebuild-launch:no-window] Start needs an open Breeze window');
    }

    // task-6fc9e503623e — LIVENESS. The pty spawned, but did the claude child
    // STAY alive? An immediate exit (bad arg, missing token, invalid cwd) is
    // the "got a pty id but no process" bug. When the verdict is not-alive,
    // RECORD the exit code + output tail to the task's activity history (so the
    // failure is self-diagnosing — nothing recorded this before), then throw a
    // tagged error carrying the exit code so the renderer surfaces it on the
    // row. The tail is token-free (claude is spawned with no PHI in argv/output
    // at this stage) but we still keep it terse and never log the MCP token.
    if (res.liveness) {
      const verdict = classifyLiveness({
        alive: res.liveness.alive,
        exitCode: res.liveness.exitCode,
        signal: res.liveness.signal,
        // Cap the tail we carry into the recorded note.
        tail: res.liveness.tail ? res.liveness.tail.slice(-800) : '',
      });
      if (!verdict.alive) {
        // Kill any lingering pty (defensive; it already exited to get here) and
        // clear its expiry registration.
        clearSession(res.ptyId);
        // Persist WHY it died so the next failure is diagnosable. Best-effort:
        // never let a note-post failure mask the launch failure.
        try {
          await this.recordLaunchFailure(id, verdict.note);
        } catch {
          /* activity-history record is best-effort */
        }
        console.warn(
          `[typebuild] task ${id}: claude child exited immediately ` +
            `(exit ${verdict.exitCode ?? 'null'})`,
        );
        // Tagged error carries the exit code so the renderer surfaces it on the
        // row (startOutcome.launchErrorReason pulls the "(exit N)" clause out).
        throw new Error(verdict.taggedError);
      }
    }
    ptyId = res.ptyId;

    // Register the live session for the expiry clock (fm-b5at.10). The token
    // itself never lands here — only its expiry + the (non-PHI) task id. A
    // relaunch overwrites the old entry's expiry with the fresh horizon, so
    // the clock re-arms automatically.
    registerSession(res.ptyId, { expiresAt: minted.expiresAt, taskId: id });

    // fm-cveh (S8) — arm the claim keep-alive for this task. A relaunch reuses
    // the same task id; startKeepAlive is idempotent (it no-ops if a timer is
    // already armed) so the renewal cadence survives the PTY swap.
    this.startKeepAlive(id);

    return { ptyId: res.ptyId };
  }

  // ─── claim keep-alive (fm-cveh/S8) ───────────────────────────────────────
  // Renewal cadence. Re-POST /claim is a no-op for the server EXCEPT it
  // refreshes the 2h TTL; firing at ~90min keeps a 2h claim comfortably alive.
  private static readonly KEEPALIVE_MS = 90 * 60_000;

  // Arm a once-per-~90min renewal for a live, Breeze-launched session's claim.
  // Idempotent: a second call for the same task (e.g. an expiry relaunch) is a
  // no-op, so the cadence isn't reset under the user.
  private startKeepAlive(taskId: string): void {
    if (this.keepAliveTimers.has(taskId)) return;
    const timer = setInterval(
      () => void this.renewClaim(taskId),
      TypeBuildTaskSource.KEEPALIVE_MS,
    );
    this.keepAliveTimers.set(taskId, timer);
  }

  // Disarm the renewal when the session ends (onExit/clearSession path).
  private stopKeepAlive(taskId: string): void {
    const timer = this.keepAliveTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(taskId);
    }
  }

  // Re-claim the task to renew the TTL. GUARD: only renew while we believe we
  // still hold the claim (cache claimedBy === my email) — if the cache shows
  // someone else (or nobody), the session already lost the claim and renewing
  // would either 409 or steal a teammate's row, so we just stop renewing. A
  // failed renew (409 = lost it) must NOT throw — we swallow it and
  // refreshAndBroadcast so the UI reflects reality. PHI-free throughout.
  private async renewClaim(taskId: string): Promise<void> {
    const me = getAuthState().email ?? null;
    const cached = this.cache.get(taskId);
    if (!me || cached?.claimedBy !== me) {
      this.stopKeepAlive(taskId);
      return;
    }
    try {
      const res = await this.request(
        'POST',
        `/chromeext/${encodeURIComponent(taskId)}/claim`,
      );
      if (!res.ok) {
        // Lost the claim (409) or it's gone (404) — stop renewing and let the
        // UI catch up. Never log/throw; the body may carry routing context we
        // don't need here.
        this.stopKeepAlive(taskId);
        await this.refreshAndBroadcast();
      }
    } catch {
      // Network blip — keep the timer armed; the next tick retries. A genuine
      // sign-out unregisters the source (stopPolling clears everything).
    }
  }

  // Build a minimal local-shape Task to feed runTaskInteractive. It NEVER
  // carries the decrypted title/body (PHI) — the prompt and label are built
  // from the opaque id only, so a benign placeholder title is safe and unused.
  // task-ab1d7955e23f (item 4) — derive a project-scoped launch context for a
  // task: the run cwd (the project's first existing folder) and the project's
  // cascading instructions (effective, NON-PHI) to inject into the session.
  //
  // Capabilities-driven + defensive: returns an empty context (caller falls
  // back to the generic tasks workspace + instruction-free prompt) when the
  // source doesn't expose projects, the task has no projectId, the project is
  // not visible / has no folders, the chosen folder doesn't exist locally, or
  // any resolve call throws. We NEVER read the task title/body here — only the
  // opaque task id and the non-PHI project (name/instructions/folders).
  private async resolveLaunchContext(
    id: string,
  ): Promise<{ cwd?: string; instructions?: string }> {
    // Projects are a capability of THIS source (getProject is always present
    // here); gate defensively in case the method is ever made optional.
    if (typeof this.getProject !== 'function') return {};
    // projectId rides the cached list row (mapListRow). No extra fetch needed
    // to learn whether the task belongs to a project.
    const projectId = this.cache.get(id)?.projectId ?? null;
    if (!projectId) return {};
    try {
      const project = await this.getProject(projectId, { effective: true });
      if (!project) return {};
      // First folder that exists locally becomes the run cwd. A folder that is
      // configured on the project but absent on THIS machine is skipped so we
      // don't spawn into a non-existent dir.
      const cwd = project.folders.find(
        (f) => typeof f === 'string' && f.trim() && existsSync(f),
      );
      const instructions =
        typeof project.effectiveInstructions === 'string' &&
        project.effectiveInstructions.trim()
          ? project.effectiveInstructions.trim()
          : undefined;
      return { cwd, instructions };
    } catch {
      // Resolve failed (network / not visible / parse) — fall back silently.
      // PHI-free: nothing about the task or project is logged.
      return {};
    }
  }

  // task-6fc9e503623e — persist WHY an auto-start session died into the task's
  // activity history, so an early-exit failure is self-diagnosing instead of a
  // silent held-claim (the reason this class of bug took several generations).
  // Uses the claim-gated /notes channel (we still hold the claim at call time)
  // and is best-effort: a failure to record must never mask the launch failure.
  // NON-PHI: the note carries only the exit code + a terse, token-free output
  // tail (the MCP token is never in claude's stdout/argv at this stage).
  private async recordLaunchFailure(id: string, note: string): Promise<void> {
    // Guard against a server that PHI-rejects an unexpected-shape note (422):
    // fall back to the shorter code-only line so we still record SOMETHING.
    const res = await this.addTaskNote(id, note).catch(() => null);
    if (res && res.ok === false && res.reason === 'phi_rejected') {
      const codeOnly = note.split('\n')[0] ?? 'Auto-start session exited immediately';
      await this.addTaskNote(id, codeOnly).catch(() => null);
    }
  }

  private syntheticTask(id: string, flags: string[]): Task {
    const now = Date.now();
    return {
      id,
      title: `TypeBuild task ${shortId(id)}`,
      notes: null,
      status: 'in_progress',
      folder: os.homedir(),
      start_at: null,
      due_at: null,
      pinned: false,
      cron: null,
      next_run_at: null,
      auto_mode: false,
      auto_agent: 'claude',
      auto_prompt: null,
      flags,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
  }

  // After an interactive session's PTY exits: refresh the list (status may
  // have changed server-side via submit_task) and, if the task is still
  // claimed by THIS principal, broadcast a gentle Release prompt. PHI-free —
  // the broadcast carries only the task id.
  private async onSessionExit(id: string): Promise<void> {
    await this.refreshAndBroadcast();
    // Mid-relaunch: the old PTY's exit is expected and the claim carries over
    // to the fresh session — don't nag the user to release it, and KEEP the
    // keep-alive armed (the fresh session still holds the claim). Consume the
    // flag so a genuine later exit of the new session still prompts.
    if (this.relaunching.has(id)) {
      this.relaunching.delete(id);
      return;
    }
    // fm-cveh (S8) — a genuine session end: disarm the claim keep-alive.
    this.stopKeepAlive(id);
    const me = getAuthState().email;
    const row = this.cache.get(id);
    if (me && row?.claimedBy && row.claimedBy === me) {
      for (const w of browserWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('typebuild:releasePrompt', { taskId: id });
        }
      }
    }
  }

  // ─── source-native verbs ────────────────────────────────────────────────
  // Task API v2 (fm-alfz/S1): PATCH /chromeext/<id> is THE management verb for
  // status changes. claim/release keep their dedicated endpoints; everything
  // else routes through patchTask().
  //
  // claim → POST /chromeext/<id>/claim (200 returns decrypted task; 409 means
  //         already claimed → return { ok:false, reason, claimedBy } rather
  //         than throwing, so the UI can show a friendly inline message).
  // release → POST /chromeext/<id>/release  (body { reason? }).
  // reopen  → SMART (fm-alfz/S1): a 'blocked' row uses the legacy
  //         POST /chromeext/<id>/reopen (kept server-side); any other terminal
  //         state (done/partial/cancelled/failed) uses PATCH {status:'open'}
  //         (which also resets attempts + clears the last error server-side).
  // complete → PATCH {status:'done'}.   cancel → PATCH {status:'cancelled'}.
  // After any mutation, patch the in-memory cache + broadcast tasks-changed
  // immediately (fm-kmhq optimistic), then refresh to reconcile.
  async sourceAction(
    taskId: string,
    action: string,
    payload?: unknown,
  ): Promise<unknown> {
    switch (action) {
      case 'claim':
        return this.claim(taskId);
      case 'release':
        return this.release(taskId, payload);
      case 'reopen':
        return this.reopen(taskId);
      case 'cancel':
        return this.cancel(taskId);
      case 'complete':
        return this.complete(taskId);
      // fm-j7w0 (S4) — generic field edit. The renderer passes a whitelisted
      // subset {assigned_to?, priority?, due_at?, defer_until?}; we route it
      // to patchTask with a matching optimistic cache patch. Any field outside
      // the whitelist is dropped (a renderer can't smuggle status/flags here).
      case 'patch':
        return this.patchFields(taskId, payload);
      default:
        throw unsupported(`action ${action}`);
    }
  }

  // ─── generic field patch (fm-j7w0/S4) ────────────────────────────────────
  // The detail panel's assignee picker + priority stepper call
  // taskSourceAction('typebuild', id, 'patch', { assigned_to | priority | ... }).
  // We accept ONLY the management fields the v2 spec's update_task_fields edits
  // and that the UI exposes; everything else is ignored. The server clears a
  // clearable string field when sent '' (assigned_to/due_at/defer_until), so
  // the picker's "Unassigned" maps to ''. We build a parallel optimistic cache
  // patch over the corresponding SourcedTask fields so the row reflects the
  // edit on the next render without waiting for the poll.
  private async patchFields(taskId: string, payload?: unknown): Promise<unknown> {
    const input = (payload ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    const cachePatch: Partial<SourcedTask> = {};

    // task-63b936d69127 — TITLE + BODY edits. The v2 management verb
    // PATCH /chromeext/<id> accepts `title` and `task` (the decrypted body),
    // re-encrypting them at rest server-side (verified against the server's
    // patch_task → set_task_body path). So a TypeBuild task's title/notes ARE
    // editable from the client now; the composer's TypeBuild edit-save sends
    // them through this whitelist. PHI: both ride home in the request body to
    // be encrypted at rest — that is allowed (the PHI invariant forbids
    // PERSISTING decrypted content LOCALLY: to disk/logs/notifications). We
    // never log the values, and we patch the (PHI, in-memory only) cache so the
    // row reflects the rename without waiting for the poll. An empty string is
    // a valid value server-side (clears the field); omitting the key leaves it.
    if ('title' in input && typeof input.title === 'string') {
      body.title = input.title;
      // title is the ONE PHI field already held in the cache (mapListRow keeps
      // titles in memory); reflect the rename optimistically.
      cachePatch.title = input.title;
    }
    if ('task' in input && typeof input.task === 'string') {
      // `task` is the decrypted body; the renderer maps it into `notes`.
      body.task = input.task;
      cachePatch.notes = input.task === '' ? null : input.task;
    }
    if ('assigned_to' in input) {
      const v = input.assigned_to;
      // '' clears server-side; cache reflects null for the cleared case.
      const s = typeof v === 'string' ? v : '';
      body.assigned_to = s;
      cachePatch.assignedTo = s === '' ? null : s;
    }
    if ('priority' in input && typeof input.priority === 'number') {
      body.priority = input.priority;
      cachePatch.priority = input.priority;
    }
    if ('due_at' in input) {
      const v = input.due_at;
      const s = typeof v === 'string' ? v : '';
      body.due_at = s;
      // due_at on the row is normalized to the day-only shape; '' clears it.
      cachePatch.due_at = s === '' ? null : dateOnly(s);
    }
    if ('defer_until' in input) {
      const v = input.defer_until;
      const s = typeof v === 'string' ? v : '';
      body.defer_until = s;
      cachePatch.deferUntil = s === '' ? null : s;
    }
    // task-ab1d7955e23f — owning project container. '' clears the association
    // (the composer's "None" option), an opaque id attaches it. Non-PHI.
    if ('project_id' in input) {
      const v = input.project_id;
      const s = typeof v === 'string' ? v : '';
      body.project_id = s;
      cachePatch.projectId = s === '' ? null : s;
    }
    // task-896f3f7f5e75 — assigned AGENT (scalar). '' clears the assignment (the
    // composer's "None" option), an opaque id attaches it. Non-PHI. An unknown
    // agent_id → the server 400s (surfaced via patchTask's throw). The cache
    // reflects the scalar id; the resolved `agent` block refreshes on the next
    // detail fetch.
    if ('agent_id' in input) {
      const v = input.agent_id;
      const s = typeof v === 'string' ? v : '';
      body.agent_id = s;
      cachePatch.agentId = s === '' ? null : s;
    }
    // task-a7214605a998 (chain linkage) — structural chain fields (opaque ids,
    // NON-PHI). The chain builder creates a job's children by instantiating
    // templates, then PATCHes each child's parent_task_id (+ depends_on on the
    // predecessor) to wire the parent-linked, ordered chain — the instantiate
    // endpoint accepts neither, so this whitelist is how the client sets them.
    // '' clears parent_task_id server-side; depends_on is a full-replace list.
    if ('parent_task_id' in input) {
      const v = input.parent_task_id;
      const s = typeof v === 'string' ? v : '';
      body.parent_task_id = s;
      cachePatch.parentTaskId = s === '' ? null : s;
    }
    if ('depends_on' in input) {
      const v = input.depends_on;
      // depends_on is a DetailRow-only field (no ListRow/cache slot), so it is
      // forwarded to the server but not mirrored into the routing cache.
      body.depends_on = Array.isArray(v)
        ? v.filter((d): d is string => typeof d === 'string')
        : [];
    }
    // task-a7214605a998 (S6) — structured output field schema edit (NON-PHI).
    // `null`/`[]` clears it server-side (the PATCH handler normalizes both to
    // `None`); we forward whatever shape the composer built (already filtered
    // to well-shaped entries) and mirror it into the cache so the drawer's
    // outputSchema reflects the edit without waiting for the next detail
    // fetch.
    if ('output_schema' in input) {
      const v = input.output_schema;
      const schema = Array.isArray(v) ? v : null;
      body.output_schema = schema;
      cachePatch.outputSchema = schema && schema.length > 0
        ? (schema as SourcedTask['outputSchema'])
        : undefined;
    }
    // task-a7214605a998 (S6) — structured data map edit (PHI values; full-bag
    // replace server-side — omitting this key entirely leaves existing data
    // untouched, per the PATCH contract). We do NOT mirror data into the
    // cache: SourcedTask carries no `data` field (values are never cached —
    // same discipline as every other PHI field here).
    if ('data' in input) {
      const v = input.data;
      body.data = v && typeof v === 'object' ? v : {};
    }

    // Nothing recognized — a no-op rather than a wasted round-trip.
    if (Object.keys(body).length === 0) return { ok: true };
    return this.patchTask(taskId, body, cachePatch);
  }

  // ─── PATCH /chromeext/<id> — the v2 management verb (fm-alfz/S1) ──────────
  // Body may carry `status` and/or field edits (priority/assigned_to/…). On
  // success we patch ONLY the fields we just changed into the cache (PHI-safe
  // routing fields — never titles/bodies) and broadcast. The 409 reason
  // vocabulary (use_claim_task, failed_is_agent_outcome, illegal_transition,
  // bad_status, not_ready[+blocked_by], last_admin, in_progress_elsewhere,
  // not_owner) is surfaced structurally so the renderer humanizes it; we never
  // throw on a 409 (it's a normal "that's not allowed" answer, not an error).
  private async patchTask(
    taskId: string,
    body: Record<string, unknown>,
    cachePatch: Partial<SourcedTask>,
  ): Promise<unknown> {
    const res = await this.request(
      'PATCH',
      `/chromeext/${encodeURIComponent(taskId)}`,
      body,
    );
    if (res.status === 404) return { ok: false, reason: 'not visible' };
    if (res.status === 409 || res.status === 400) {
      const data = (await res.json().catch(() => ({}))) as {
        reason?: string;
        claimed_by?: string | null;
        blocked_by?: string[] | null;
      };
      return {
        ok: false,
        reason: data.reason ?? 'rejected',
        claimedBy: data.claimed_by ?? null,
        blockedBy: Array.isArray(data.blocked_by) ? data.blocked_by : undefined,
      };
    }
    if (!res.ok) throw new Error(`typebuild: patch failed (${res.status})`);
    // Reflect only the fields we just changed (fm-kmhq optimistic).
    this.patchCacheAndBroadcast(taskId, cachePatch);
    return { ok: true };
  }

  // ─── optimistic cache patch + broadcast (fm-kmhq) ────────────────────────
  // After a mutation's POST has SUCCEEDED on the server, patch the in-memory
  // cached row so every window reflects the new state on the very next pull —
  // without waiting for the ~30s poll. We broadcast immediately, then kick a
  // fire-and-forget refreshAndBroadcast() to reconcile against authoritative
  // server state (the POST already succeeded, so the next list returns the
  // same fields; this just folds in anything else that moved server-side).
  // PHI-safe: we only ever patch routing fields (status/claimedBy/...), never
  // titles or bodies, and never log them.
  private patchCacheAndBroadcast(taskId: string, patch: Partial<SourcedTask>): void {
    const row = this.cache.get(taskId);
    if (row) {
      const next = { ...row, ...patch };
      this.cache.set(taskId, next);
      // task-b3fb2928bb3c (Phase 1) — mirror the NON-PHI routing fields to disk
      // so an optimistic mutation survives a restart-before-next-poll. Projects
      // the row through cacheRowToSkeleton (title/body never read). Best-effort.
      try {
        patchSkeleton(taskId, this.cacheRowToSkeleton(next));
      } catch (e) {
        console.warn('[typebuild] skeleton patch failed:', (e as Error).message);
      }
    }
    // Immediate broadcast so the UI flips without the poll latency.
    breezeHost().onTasksChanged();
    // Reconcile against the server in the background. A failure here is
    // non-fatal — the optimistic patch already reflects the succeeded POST.
    void this.refreshAndBroadcast();
  }

  private async claim(taskId: string): Promise<unknown> {
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/claim`,
    );
    if (res.status === 409) {
      // Already claimed by someone else — don't throw; surface a structured
      // result the renderer renders inline.
      const data = (await res.json().catch(() => ({}))) as {
        reason?: string;
        claimed_by?: string | null;
      };
      return {
        ok: false,
        reason: data.reason ?? 'already claimed',
        claimedBy: data.claimed_by ?? null,
      };
    }
    if (res.status === 404) return { ok: false, reason: 'not visible' };
    if (!res.ok) throw new Error(`typebuild: claim failed (${res.status})`);
    const detail = (await res.json().catch(() => ({}))) as DetailRow;
    // Optimistically reflect MY claim immediately (fm-kmhq) so the row flips
    // to "claimed by me" without waiting for the poll. The signed-in email is
    // the principal that just succeeded the claim.
    const me = getAuthState().email ?? null;
    this.patchCacheAndBroadcast(taskId, { claimedBy: me });
    // Return the mapped (decrypted) task so the caller can render it from
    // memory if it wants; the renderer treats the body as PHI-in-memory only.
    return { ok: true, task: this.mapDetail(detail, taskId) };
  }

  private async release(taskId: string, payload?: unknown): Promise<unknown> {
    const reason = (payload as { reason?: string } | undefined)?.reason;
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/release`,
      reason ? { reason } : {},
    );
    if (res.status === 404) return { ok: false, reason: 'not visible' };
    if (!res.ok) throw new Error(`typebuild: release failed (${res.status})`);
    // Optimistically drop the claim (fm-kmhq) so the row stops showing "me".
    this.patchCacheAndBroadcast(taskId, { claimedBy: null });
    return { ok: true };
  }

  // Smart reopen (fm-alfz/S1). The legacy POST /reopen stays BLOCKED-ONLY by
  // server design, so only a 'blocked' row uses it; every other terminal state
  // (done/partial/cancelled/failed) reopens via PATCH {status:'open'} — which
  // additionally resets attempts and clears the last error server-side.
  private async reopen(taskId: string): Promise<unknown> {
    const raw = this.cache.get(taskId)?.rawStatus;
    if (raw === 'blocked') {
      const res = await this.request(
        'POST',
        `/chromeext/${encodeURIComponent(taskId)}/reopen`,
      );
      if (res.status === 404) return { ok: false, reason: 'not visible' };
      if (!res.ok) throw new Error(`typebuild: reopen failed (${res.status})`);
      // Optimistically flip back to the 'open' equivalent (fm-kmhq): the local
      // mapped status is 'pending' for 'open', and the badge tracks rawStatus.
      this.patchCacheAndBroadcast(taskId, {
        status: 'pending',
        rawStatus: 'open',
        completed_at: null,
      });
      return { ok: true };
    }
    // Terminal (done/partial/cancelled/failed) → reopen via the v2 verb.
    return this.patchTask(
      taskId,
      { status: 'open' },
      { status: 'pending', rawStatus: 'open', completed_at: null },
    );
  }

  // ─── complete / cancel (fm-alfz/S1) ──────────────────────────────────────
  // The desktop's mark-done / cancel paths for a remote TypeBuild task, both
  // through the live v2 management verb. `done` and `cancelled` are allowed
  // from any status (the server clears the claim + records an override
  // submission), so neither carries a payload.
  private async complete(taskId: string): Promise<unknown> {
    return this.patchTask(
      taskId,
      { status: 'done' },
      {
        status: 'done',
        rawStatus: 'done',
        claimedBy: null,
        completed_at: Date.now(),
      },
    );
  }

  private async cancel(taskId: string): Promise<unknown> {
    return this.patchTask(
      taskId,
      { status: 'cancelled' },
      {
        status: 'cancelled',
        rawStatus: 'cancelled',
        claimedBy: null,
        completed_at: Date.now(),
      },
    );
  }

  // ─── cache refresh + broadcast ──────────────────────────────────────────
  // Re-pull the list (titles + terminal states) into the cache and fire the
  // tasks-changed broadcast through the BreezeHost so every window re-pulls.
  private async refreshAndBroadcast(): Promise<void> {
    try {
      await this.listTasks({ includeDone: true });
    } catch {
      // A refresh failure is non-fatal — the action already happened on the
      // server. Still broadcast so the UI re-pulls and reconciles.
    }
    breezeHost().onTasksChanged();
  }

  // ─── polling lifecycle ──────────────────────────────────────────────────
  // Called by the registration wiring when the source is registered /
  // unregistered (sign-in / sign-out).
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    // Kick an immediate pull so the UI populates without waiting 30s.
    void this.poll();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // fm-cveh (S8) — sign-out drops the source; disarm every claim keep-alive.
    for (const timer of this.keepAliveTimers.values()) clearInterval(timer);
    this.keepAliveTimers.clear();
    this.cache.clear();
    this.lastSignature = '';
    this.firstPoll = true;
    this.pollCount = 0;
    // task-b3fb2928bb3c (Phase 1) — sign-out drops the source. Wipe the
    // persistent skeleton so a different principal signing in on this machine
    // never sees the prior account's routing skeleton on cold start. PHI-free
    // either way (skeleton holds no titles/bodies), but the routing set is
    // account-scoped so it must not leak across sign-ins.
    try {
      clearSkeleton();
    } catch (e) {
      console.warn('[typebuild] skeleton clear failed:', (e as Error).message);
    }
  }

  // task-b1fe80e2669b (Phase 2) — the poll loop is now DELTA-first:
  //   • No cursor yet (first poll after sign-in / cold start) → FULL pull to
  //     SEED the cache + skeleton, and capture the server_time as the cursor.
  //   • Cursor present → DELTA pull (?updated_since=<cursor>): upsert only the
  //     changed rows, apply tombstones DIRECTLY (delete those ids), advance the
  //     cursor to the new server_time. Cheap and skew-free.
  //   • Every FULL_RECONCILE_EVERY-th poll → a FULL pull anyway (safety net:
  //     converge on server truth in case a tombstone was missed).
  // Edge cases handled inside: empty delta (no broadcast), a server that omits
  // the delta envelope (treated as a full response), missing server_time (fall
  // back to a full pull next time by NOT advancing the cursor), and offline /
  // failed pulls (keep the last-known cache + cursor, retry next tick).
  private async poll(): Promise<void> {
    // Pause when there's no window to update — saves a token round-trip and
    // server load while the app is closed-but-running (macOS dock).
    if (browserWindows().every((w) => w.isDestroyed())) return;

    // Read the persisted cursor. A read failure → treat as no cursor (full).
    let cursor: string | null = null;
    try {
      cursor = getSyncCursor();
    } catch {
      cursor = null;
    }
    // Force a periodic FULL reconcile (safety net) regardless of the cursor.
    const forceFull = this.pollCount >= FULL_RECONCILE_EVERY;

    try {
      if (cursor && !forceFull) {
        await this.pollDelta(cursor);
      } else {
        await this.pollFull();
      }
    } catch {
      // Signed-out / network blip — stay quiet; the next poll retries with the
      // SAME cursor (we never advanced it on failure) and the last-known cache
      // is left intact (we never wipe on error). sign-out unregisters anyway.
    }
  }

  // Shared remote-transition notification (fm-h8g7). Diffs the freshly-mapped
  // rows against the CURRENT cache (not a prior snapshot) so any action THIS app
  // took already patched the cache and produces NO transition — only genuinely
  // remote changes do. Routing-only inputs (PHI-free). Tombstoned ids are NOT
  // passed here (a removal isn't a status transition to notify on).
  private notifyTransitions(freshRows: ListRow[]): void {
    try {
      const me = getAuthState().email ?? null;
      const prev = [...this.cache.values()].map((t) => ({
        id: t.id,
        status: t.status,
        rawStatus: t.rawStatus,
        claimedBy: t.claimedBy ?? null,
      }));
      const fresh = freshRows.map((r) => {
        const mapped = mapListRow(r);
        return {
          id: mapped.id,
          status: mapped.status,
          rawStatus: mapped.rawStatus,
          claimedBy: mapped.claimedBy ?? null,
        };
      });
      const transitions = classifyTransitions(prev, fresh, me, this.firstPoll);
      if (transitions.length > 0) {
        breezeHost().onTaskTransitions?.(
          transitions.map((t) => ({ ...t, source: this.id })),
        );
      }
    } catch {
      // A classifier/notify failure must never break the poll's cache refresh.
    }
  }

  // Broadcast a SkeletonDiff: the structured diff when non-empty, else a
  // detail-free ping so the renderer re-pulls a memory-only title change.
  private broadcastDiff(diff: SkeletonDiff): void {
    if (diffIsEmpty(diff)) breezeHost().onTasksChanged();
    else breezeHost().onTasksChanged(this.toChangedDetail(diff));
  }

  // The epoch-0 watermark we use to SEED a full pull that also returns a cursor.
  // updated_since=1970 → "everything changed since the dawn of time" → the whole
  // inventory, PLUS the delta envelope (server_time + tombstones). This lets the
  // FULL/seed pull and the periodic safety-net pull both capture a fresh cursor
  // while still reconciling against the complete server set (absence-tombstoned).
  private static readonly EPOCH_ZERO = '1970-01-01T00:00:00Z';

  // FULL pull — reconcile against the COMPLETE server inventory (absence-based
  // tombstoning) AND capture a fresh cursor. We request updated_since=epoch-0 so
  // the delta-aware server returns every row plus server_time; an older server
  // that ignores updated_since still returns {tasks} and we simply don't get a
  // cursor (staying on full pulls — fully backward compatible). Resets the
  // safety-net counter.
  private async pollFull(): Promise<void> {
    const params = new URLSearchParams({ titles: '1', all: '1' });
    params.set('updated_since', TypeBuildTaskSource.EPOCH_ZERO);
    const res = await this.request('GET', `/chromeext/tasks?${params}`);
    if (!res.ok) return;
    const data = (await res.json().catch(() => ({}))) as {
      tasks?: ListRow[];
      tombstones?: Array<{ id: string; deleted_at?: string }>;
      server_time?: string;
    };
    const rows = Array.isArray(data.tasks) ? data.tasks : [];
    const sig = this.signatureOf(rows);
    // A full pull always resets the safety counter and (when present) advances
    // the cursor so subsequent polls go delta.
    this.pollCount = 0;
    this.maybeAdvanceCursor(data.server_time);
    if (sig === this.lastSignature) {
      // Nothing moved since the last pull, but mark firstPoll consumed so the
      // first real change after a quiet cold start still notifies.
      this.firstPoll = false;
      return;
    }

    this.notifyTransitions(rows);
    // Reconcile fresh rows → cache + skeleton (full absence-based tombstoning).
    const diff = this.reconcileFromRows(rows);
    this.lastSignature = sig;
    this.firstPoll = false;
    this.broadcastDiff(diff);
  }

  // DELTA pull — request only rows changed since the cursor + the tombstones.
  // Applies the changed rows + DELETES the tombstoned ids directly, then
  // advances the cursor to the new server_time. Defends against a server that
  // (unexpectedly) answers WITHOUT the delta envelope by treating it as a full
  // response.
  private async pollDelta(cursor: string): Promise<void> {
    const params = new URLSearchParams({ titles: '1', all: '1' });
    params.set('updated_since', cursor);
    const res = await this.request('GET', `/chromeext/tasks?${params}`);
    if (!res.ok) return; // keep cursor + cache; retry next tick
    const data = (await res.json().catch(() => ({}))) as {
      tasks?: ListRow[];
      tombstones?: Array<{ id: string; deleted_at?: string }>;
      server_time?: string;
    };

    // Defensive: if the server answered without the delta envelope (no
    // server_time AND no tombstones key), it behaved like a FULL response — the
    // `tasks` are the whole inventory, not a delta. Reconcile as full so we
    // don't mistake "every other row" for unchanged.
    const isDeltaEnvelope =
      typeof data.server_time === 'string' || Array.isArray(data.tombstones);
    if (!isDeltaEnvelope) {
      const rows = Array.isArray(data.tasks) ? data.tasks : [];
      const sig = this.signatureOf(rows);
      this.pollCount = 0;
      if (sig === this.lastSignature) return;
      this.notifyTransitions(rows);
      const diff = this.reconcileFromRows(rows);
      this.lastSignature = sig;
      this.firstPoll = false;
      this.broadcastDiff(diff);
      return;
    }

    const changedRows = Array.isArray(data.tasks) ? data.tasks : [];
    const tombstones = Array.isArray(data.tombstones)
      ? data.tombstones
          .map((t) => t?.id)
          .filter((id): id is string => typeof id === 'string')
      : [];

    this.pollCount += 1;

    // Empty delta — nothing changed and nothing deleted. Advance the cursor
    // (so we don't re-ask the same window) but skip the broadcast entirely.
    if (changedRows.length === 0 && tombstones.length === 0) {
      this.maybeAdvanceCursor(data.server_time);
      return;
    }

    // Notify on remote status transitions among the changed rows (PHI-free).
    this.notifyTransitions(changedRows);

    // Apply the delta to cache + skeleton: upsert changed, delete tombstoned.
    const diff = this.reconcileDelta(changedRows, tombstones);
    // Keep the signature fresh so a follow-up FULL pull's no-op short-circuit
    // still works. Recompute over the current cache's list-shape.
    this.lastSignature = this.signatureOf(this.cacheAsListRows());
    this.firstPoll = false;
    // Advance the cursor LAST (after a successful apply) so a crash mid-apply
    // re-reads the same window next time rather than skipping it.
    this.maybeAdvanceCursor(data.server_time);

    this.broadcastDiff(diff);
  }

  // Advance (persist) the sync cursor to `server_time` when present. A missing
  // server_time is handled defensively: we DON'T advance, so the next poll
  // replays the same window (or, if there was never a cursor, stays on full).
  private maybeAdvanceCursor(serverTime: string | undefined): void {
    if (typeof serverTime !== 'string' || serverTime === '') return;
    try {
      setSyncCursor(serverTime);
    } catch (e) {
      console.warn('[typebuild] cursor persist failed:', (e as Error).message);
    }
  }

  // Project the in-memory cache back to list-row shape for signature recompute
  // after a delta apply. Routing fields + title only (title is already in
  // memory; never persisted). PHI-free on disk — this stays in memory.
  private cacheAsListRows(): ListRow[] {
    return [...this.cache.values()].map((t) => ({
      id: t.id,
      status: t.status,
      raw_status: t.rawStatus,
      claimed_by: t.claimedBy ?? null,
      attempts: t.attempts,
      title: t.title,
    }));
  }

  // A cheap change-detection signature over the routing-relevant fields. We
  // include titles (already in memory, not persisted) so a rename surfaces.
  private signatureOf(rows: ListRow[]): string {
    return rows
      .map(
        (r) =>
          `${r.id}:${rawStatusOf(r)}:${r.claimed_by ?? ''}:${r.attempts ?? ''}:${r.title ?? ''}`,
      )
      .sort()
      .join('|');
  }
}
