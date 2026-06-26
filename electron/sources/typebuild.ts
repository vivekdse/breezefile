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
import { classifyTransitions } from './typebuild-transitions.mjs';
import { getAuthState, getIdToken } from '../typebuild/auth';
import { mintMcpToken } from '../typebuild/mcp-token';
import { clearSession, registerSession } from '../typebuild/sessions';
import { browserCliAllowRules } from '../browser/automation';
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
};

/** Decrypted detail from GET /chromeext/<id>. `task` is the body (PHI). */
type DetailRow = ListRow & {
  task?: string | null; // decrypted body
  notes?: string | null;
  claimed_at?: string | number | null;
  skills?: unknown;
  // fm-lji6 (S2) — detail-only dependency fields. Memory-only; ids are
  // opaque (non-PHI) so they're safe to carry, but never persisted/logged.
  depends_on?: string[] | null;
  deps_satisfied?: boolean | null;
  blocked_by?: string[] | null;
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

function mapListRow(row: ListRow): SourcedTask {
  const raw = rawStatusOf(row);
  // The list endpoint carries no created/updated timestamps — the local Task
  // shape requires numeric created_at/updated_at. Use `now` as a benign
  // placeholder so the renderer's sorts/filters don't choke; remote rows are
  // grouped by source, not sorted on these. completed_at stays null unless
  // the row is done.
  const now = Date.now();
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
    created_at: now,
    // fm-alfz (S1) — terminal rows (done | cancelled) get a completed_at so
    // they sort sensibly in the DONE section (completed_at desc); non-terminal
    // rows leave it null.
    updated_at: now,
    completed_at: status === 'done' || status === 'cancelled' ? now : null,
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

    // Refresh the in-memory cache from the fresh list.
    this.cache = new Map(rows.map((r) => [r.id, mapListRow(r)]));
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
      // fm-lji6 (S2) — dependency fields (detail only). Memory-only; ids are
      // opaque (non-PHI). Used by S3's "waiting on N tasks" presentation.
      dependsOn: Array.isArray(detail.depends_on) ? detail.depends_on : undefined,
      depsSatisfied:
        typeof detail.deps_satisfied === 'boolean'
          ? detail.deps_satisfied
          : undefined,
      blockedBy: Array.isArray(detail.blocked_by) ? detail.blocked_by : undefined,
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
    const payload: Record<string, unknown> = { title, task: body };
    // due_at: the composer passes day-only or ISO; pass it straight through
    // (the server stores the ISO string verbatim). Omit when null/empty.
    if (input.due_at) payload.due_at = input.due_at;
    if (input.deferUntil) payload.defer_until = input.deferUntil;
    if (typeof input.priority === 'number') payload.priority = input.priority;
    // task-ab1d7955e23f — optional project container. Opaque id (non-PHI).
    if (input.projectId) payload.project_id = input.projectId;

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
    });
    // notes (the body) is PHI-in-memory; attach it for the immediate return so
    // the composer can show the just-created task without a re-fetch.
    const seeded: SourcedTask = { ...mapped, notes: body || null };
    this.cache.set(id, seeded);
    breezeHost().onTasksChanged();
    void this.refreshAndBroadcast();
    return seeded;
  }

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
    return project;
  }

  // GET /chromeext/projects → { projects: [...] }. Returns [] on a parse miss.
  async listProjects(): Promise<Project[]> {
    const res = await this.request('GET', '/chromeext/projects');
    if (!res.ok) {
      throw new Error(`typebuild: list projects failed (${res.status})`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      projects?: ProjectRow[];
    };
    const rows = Array.isArray(data.projects) ? data.projects : [];
    return rows.map((r) => this.mapProjectRow(r));
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
  //        - prompt: "Run /mcp__typebuild__work and claim task <id>"
  //          (ONLY the opaque task id — no PHI).
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
      return { ok: true, ptyId: res.ptyId };
    } catch (err) {
      // The mint/spawn threw AFTER we just claimed in THIS call — the claim is
      // now orphaned (no live session backs it). Fire the same Release prompt
      // the PTY-exit path uses (typebuild.ts onSessionExit) so the user can
      // release it, then rethrow so the renderer maps the typed mint error.
      // PHI-free: the broadcast carries only the opaque task id.
      if (!alreadyMine) {
        for (const w of browserWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send('typebuild:releasePrompt', { taskId: id });
          }
        }
      }
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
    const synthetic: Task = this.syntheticTask(id, flags);

    // App-owned workspace + permission grant (see ensureTasksWorkspace). The
    // session runs here and loads the seeded settings via --settings below.
    const { cwd: tasksCwd, settingsPath } = ensureTasksWorkspace();

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
      ? `Task ${id} is already claimed by me. Run /mcp__typebuild__work for task ${id} — do not claim it again.`
      : `Run /mcp__typebuild__work and claim task ${id}`;
    // Prepend the project's effective instructions (NON-PHI) as context so the
    // agent operates with the project's cascading guidance from the first turn.
    const prompt = projectCtx.instructions
      ? `${projectCtx.instructions}\n\n---\n\n${basePrompt}`
      : basePrompt;

    let ptyId = 0;
    const res = await runTaskInteractive(synthetic, {
      agentId: 'claude',
      // ONLY the opaque task id — never a title/body (PHI).
      prompt,
      // On resume, suppress the positional prompt so --continue resumes the
      // existing conversation rather than seeding a new /work claim.
      omitPrompt: opts.resume,
      // Project folder when the task belongs to a project (resolveLaunchContext),
      // else the generic app-owned tasks workspace.
      cwd: runCwd,
      // No local run row: FK to tasks(id) would fail for a remote id.
      recordRun: false,
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
        '--strict-mcp-config', '--mcp-config', MCP_INLINE_CONFIG,
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
      // No GUI window to host the tab — interactive Start needs the app open.
      throw new Error('typebuild: Start needs an open Breeze window');
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
    if (row) this.cache.set(taskId, { ...row, ...patch });
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
  }

  private async poll(): Promise<void> {
    // Pause when there's no window to update — saves a token round-trip and
    // server load while the app is closed-but-running (macOS dock).
    if (browserWindows().every((w) => w.isDestroyed())) return;
    try {
      const res = await this.request('GET', `/chromeext/tasks?titles=1&all=1`);
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { tasks?: ListRow[] };
      const rows = Array.isArray(data.tasks) ? data.tasks : [];
      const sig = this.signatureOf(rows);
      if (sig === this.lastSignature) return; // nothing changed

      // fm-h8g7 — classify remote transitions BEFORE replacing the cache.
      // We diff the FRESH rows against the CURRENT cache (not the previous
      // poll snapshot): any action THIS app took (claim/release/reopen/
      // complete) already patched the cache via patchCacheAndBroadcast, so it
      // produces NO transition here — only genuinely remote changes do. That
      // is the self-suppression mechanism. Inputs are routing-only (PHI-free).
      try {
        const me = getAuthState().email ?? null;
        const prev = [...this.cache.values()].map((t) => ({
          id: t.id,
          status: t.status,
          rawStatus: t.rawStatus,
          claimedBy: t.claimedBy ?? null,
        }));
        const fresh = rows.map((r) => {
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
        // A classifier/notify failure must never break the poll's cache
        // refresh — swallow and continue. Never log task content.
      }

      this.cache = new Map(rows.map((r) => [r.id, mapListRow(r)]));
      this.lastSignature = sig;
      this.firstPoll = false;
      breezeHost().onTasksChanged();
    } catch {
      // Signed-out / network blip — stay quiet; the next poll retries, and
      // sign-out unregisters this source anyway.
    }
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
