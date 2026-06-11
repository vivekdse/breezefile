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
import { BrowserWindow } from 'electron';
import { breezeHost } from '../core/host';
import { getAuthState, getIdToken } from '../typebuild/auth';
import { mintMcpToken } from '../typebuild/mcp-token';
import { clearSession, registerSession } from '../typebuild/sessions';
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

const capabilities: TaskSourceCapabilities = {
  canSchedule: false,
  canClaim: true,
  canEdit: false,
  canDelete: false,
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
};

/** Decrypted detail from GET /chromeext/<id>. `task` is the body (PHI). */
type DetailRow = ListRow & {
  task?: string | null; // decrypted body
  notes?: string | null;
  claimed_at?: string | number | null;
  skills?: unknown;
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

function mapListRow(row: ListRow): SourcedTask {
  const raw = rawStatusOf(row);
  // The list endpoint carries no timestamps — the local Task shape requires
  // numeric created_at/updated_at. Use `now` as a benign placeholder so the
  // renderer's sorts/filters don't choke; remote rows are grouped by source,
  // not sorted on these. completed_at stays null unless the row is done.
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
    due_at: null,
    pinned: false,
    cron: null,
    next_run_at: null,
    auto_mode: false,
    auto_agent: null,
    auto_prompt: null,
    created_at: now,
    updated_at: now,
    completed_at: status === 'done' ? now : null,
    // Source-specific fields.
    source: 'typebuild',
    rawStatus: raw,
    priority: typeof row.priority === 'number' ? row.priority : undefined,
    claimedBy: row.claimed_by ?? null,
    attempts: typeof row.attempts === 'number' ? row.attempts : undefined,
    maxAttempts:
      typeof row.max_attempts === 'number' ? row.max_attempts : undefined,
    // Local Task.flags is a required string[] (fm-b5at.7); default to [].
    flags: Array.isArray(row.flags) ? row.flags : [],
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

  // fm-b5at.10 — task ids whose session is mid-relaunch. The relaunch kills the
  // old PTY, whose onExit would otherwise fire the "Release this task?" prompt
  // (the user still holds the claim during the swap). We suppress that prompt
  // while a relaunch for the same task is in flight; the fresh session re-uses
  // the same claim, so there is nothing to release.
  private relaunching = new Set<string>();

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
    // Pull terminal states (done/partial/blocked) when the filter wants done
    // rows. The renderer applies its own status filter on top.
    if (filter.includeDone !== false) params.set('all', '1');

    const res = await this.request('GET', `/chromeext/tasks?${params}`);
    if (!res.ok) {
      // Surface a terse, PHI-free error — never log title/body content.
      throw new Error(`typebuild: list failed (${res.status})`);
    }
    const data = (await res.json().catch(() => ({}))) as { tasks?: ListRow[] };
    const rows = Array.isArray(data.tasks) ? data.tasks : [];

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

  // Map a decrypted detail row into a SourcedTask. The body (`task`) goes into
  // `notes` — that's what the existing detail UI renders. Memory only.
  private mapDetail(detail: DetailRow, fallbackId: string): SourcedTask {
    const base = mapListRow({ ...detail, id: detail.id ?? fallbackId });
    return {
      ...base,
      // Decrypted body → notes (PHI; rendered from React state only).
      notes: detail.task ?? detail.notes ?? null,
    };
  }

  // ─── mutations (unsupported) ────────────────────────────────────────────
  createTask(_input: TaskCreate): never {
    throw unsupported('createTask — TypeBuild tasks are read-only here');
  }
  updateTask(_id: string, _patch: TaskUpdate): never {
    throw unsupported('updateTask — TypeBuild tasks are read-only here');
  }
  deleteTask(_id: string): never {
    throw unsupported('deleteTask — TypeBuild tasks cannot be deleted here');
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
  //   6. Claim is IN-SESSION (the /work prompt claims via MCP). We do NOT
  //      pre-claim over REST (a REST pre-claim would 409 the in-session
  //      claim, which is conditional on status=open).
  //   7. After the PTY exits: refresh + broadcast; if the task is still
  //      claimed by THIS principal, broadcast a Release prompt.
  async runNow(id: string, _opts?: RunNowOptions): Promise<unknown> {
    const res = await this.launchSession(id, { resume: false });
    return { ok: true, ptyId: res.ptyId };
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
    for (const w of BrowserWindow.getAllWindows()) {
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
    opts: { resume: boolean },
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
    // flags (e.g. chrome → --chrome). 'interactive' is a no-op for flagsToArgs
    // but documents intent; runTaskInteractive ignores it for arg purposes. On
    // a relaunch we add 'resume' (→ --continue) so the prior conversation
    // continues with the fresh token instead of starting cold.
    const flags = Array.from(
      new Set([
        ...serverFlags,
        'interactive',
        ...(opts.resume ? ['resume'] : []),
      ]),
    );

    const { runTaskInteractive } = await import('../agents/interactive');
    const synthetic: Task = this.syntheticTask(id, flags);

    let ptyId = 0;
    const res = await runTaskInteractive(synthetic, {
      agentId: 'claude',
      // ONLY the opaque task id — never a title/body (PHI).
      prompt: `Run /mcp__typebuild__work and claim task ${id}`,
      // On resume, suppress the positional prompt so --continue resumes the
      // existing conversation rather than seeding a new /work claim.
      omitPrompt: opts.resume,
      cwd: os.homedir(),
      // No local run row: FK to tasks(id) would fail for a remote id.
      recordRun: false,
      // PHI: generic, content-free tab label.
      label: `TypeBuild task ${shortId(id)}`,
      source: this.id,
      // --strict-mcp-config: load ONLY our inline server (header-injected),
      // ignoring user/project scope and avoiding a name collision with the
      // plugin's header-free .mcp.json. The inline config holds the ${VAR}
      // reference, NOT the secret.
      extraArgs: ['--strict-mcp-config', '--mcp-config', MCP_INLINE_CONFIG],
      env: {
        // The minted token, PTY env only. claude expands ${TYPEBUILD_MCP_TOKEN}
        // from here into the Authorization header. Never logged/persisted.
        [MCP_TOKEN_ENV]: minted.accessToken,
        // PHI-free marker so the renderer can gate TypeBuild-tab behavior.
        BREEZE_TYPEBUILD_TASK: '1',
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

    return { ptyId: res.ptyId };
  }

  // Build a minimal local-shape Task to feed runTaskInteractive. It NEVER
  // carries the decrypted title/body (PHI) — the prompt and label are built
  // from the opaque id only, so a benign placeholder title is safe and unused.
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
    // to the fresh session — don't nag the user to release it. Consume the
    // flag so a genuine later exit of the new session still prompts.
    if (this.relaunching.has(id)) {
      this.relaunching.delete(id);
      return;
    }
    const me = getAuthState().email;
    const row = this.cache.get(id);
    if (me && row?.claimedBy && row.claimedBy === me) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('typebuild:releasePrompt', { taskId: id });
        }
      }
    }
  }

  // ─── source-native verbs ────────────────────────────────────────────────
  // claim → POST /chromeext/<id>/claim (200 returns decrypted task; 409 means
  //         already claimed → return { ok:false, reason, claimedBy } rather
  //         than throwing, so the UI can show a friendly inline message).
  // release → POST /chromeext/<id>/release  (body { reason? }).
  // reopen  → POST /chromeext/<id>/reopen   (for blocked tasks).
  // After any mutation, refresh the cache and broadcast tasks-changed.
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
      default:
        throw unsupported(`action ${action}`);
    }
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
    await this.refreshAndBroadcast();
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
    await this.refreshAndBroadcast();
    return { ok: true };
  }

  private async reopen(taskId: string): Promise<unknown> {
    const res = await this.request(
      'POST',
      `/chromeext/${encodeURIComponent(taskId)}/reopen`,
    );
    if (res.status === 404) return { ok: false, reason: 'not visible' };
    if (!res.ok) throw new Error(`typebuild: reopen failed (${res.status})`);
    await this.refreshAndBroadcast();
    return { ok: true };
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
    this.cache.clear();
    this.lastSignature = '';
  }

  private async poll(): Promise<void> {
    // Pause when there's no window to update — saves a token round-trip and
    // server load while the app is closed-but-running (macOS dock).
    if (BrowserWindow.getAllWindows().every((w) => w.isDestroyed())) return;
    try {
      const res = await this.request('GET', `/chromeext/tasks?titles=1&all=1`);
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { tasks?: ListRow[] };
      const rows = Array.isArray(data.tasks) ? data.tasks : [];
      const sig = this.signatureOf(rows);
      if (sig === this.lastSignature) return; // nothing changed
      this.cache = new Map(rows.map((r) => [r.id, mapListRow(r)]));
      this.lastSignature = sig;
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
