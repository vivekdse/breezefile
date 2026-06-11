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

import { BrowserWindow } from 'electron';
import { breezeHost } from '../core/host';
import { getIdToken } from '../typebuild/auth';
import type {
  RunNowOptions,
  SourcedTask,
  TaskSource,
  TaskSourceCapabilities,
} from '../core/task-source';
import { unsupported } from '../core/task-source';
import type { TaskCreate, TaskFilter, TaskStatus, TaskUpdate } from '../tasks';

const API_BASE = 'https://general.typebuild.com';
const POLL_INTERVAL_MS = 30_000;

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

  // ─── runNow (stub; fm-b5at.5) ───────────────────────────────────────────
  // The interactive launch ("Start") lands with fm-b5at.5, which will replace
  // this stub with a tab-spawning, in-session-claim flow.
  async runNow(_id: string, _opts?: RunNowOptions): Promise<unknown> {
    throw unsupported('runNow — lands with fm-b5at.5');
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
