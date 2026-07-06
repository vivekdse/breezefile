// task-3ac8cbe60758 — pure wire-mapping helpers extracted out of
// electron/sources/typebuild.ts so they're unit-testable without the
// fetch/Electron-coupled TaskSource class around them. Plain `.mjs` (mirrors
// src/components/newhome/taskSchema.mjs / pipelineRoster.mjs) so it runs
// under `node --test` with no transpile step; the .d.mts sibling gives TS
// consumers types. This is a PURE REFACTOR: every function here is a
// byte-identical move out of typebuild.ts — no behavior change.
//
// PHI rule (same discipline as typebuild.ts itself): task titles/bodies/
// result payloads/messages/pending-question text are potentially PHI. These
// functions only SHAPE values already in memory — they never log or persist
// them; callers must keep the same discipline.

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
export function mapStatus(raw) {
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
export function rawStatusOf(row) {
  if (row.blocked) return 'blocked';
  return row.raw_status ?? row.status ?? 'open';
}

// fm-lji6 (S2) — normalize a server ISO timestamp to the local 'YYYY-MM-DD'
// date part. Local rows store dates day-only; the due-date pill renders from
// that shape, so we trim the time to keep both legs identical. Returns null
// for nullish/empty input.
export function dateOnly(iso) {
  if (!iso) return null;
  // 'YYYY-MM-DDTHH:MM:SSZ' or 'YYYY-MM-DD' → 'YYYY-MM-DD'. Cheap slice on the
  // ISO 8601 'T' separator; pass through anything already day-only.
  const t = iso.indexOf('T');
  return t > 0 ? iso.slice(0, t) : iso.slice(0, 10);
}

// task-b8306d2b85c2 — normalize a claimed_at that may arrive as an ISO string
// or an epoch (seconds or ms) into a single ISO string the UI can parse. NON-
// PHI (a timestamp). Returns null for nullish/empty/unparseable input.
export function toIso(v) {
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
export function isoToMs(v) {
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
export function mapResult(r) {
  if (!r || typeof r !== 'object') return undefined;
  if (typeof r.type !== 'string' || !r.type) return undefined;
  return { type: r.type, payload: r.payload ?? null };
}

const OUTPUT_FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'bool']);

function isOutputSchemaFieldLike(v) {
  if (!v || typeof v !== 'object') return false;
  const f = v;
  if (typeof f.key !== 'string' || !f.key) return false;
  if (typeof f.label !== 'string' || !f.label) return false;
  if (typeof f.type !== 'string' || !OUTPUT_FIELD_TYPES.has(f.type)) return false;
  if (f.options !== undefined && !Array.isArray(f.options)) return false;
  if (f.required !== undefined && typeof f.required !== 'boolean') return false;
  return true;
}

// task-ce4b4c8ca955 — map the server's `output_schema` (a flat array of
// TaskDefField-shaped entries) into the client's SourcedTask.outputSchema.
// Defensive: drop malformed entries rather than rejecting the whole array
// (same fail-soft convention as mapMessages/mapPendingQuestion);
// absent/empty/malformed → undefined so a task with no server schema renders
// exactly as today (NON-REGRESSION). NON-PHI: field DEFINITIONS only
// (key/label/type/options/required) — never values, which ride
// `result.payload` as always.
export function mapOutputSchema(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(isOutputSchemaFieldLike);
  return out.length ? out : undefined;
}

// task-4a8d2c98f667 — normalize the wire `data_keys` into string[] | undefined.
// NON-PHI: key NAMES only, never values. Defensive: a non-array or an array
// of non-strings drops to undefined/filters out the bad entries rather than
// rejecting the whole task, matching mapOutputSchema's fail-soft rule.
export function mapDataKeys(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((k) => typeof k === 'string' && k.length > 0);
  return out.length ? out : undefined;
}

// task-da23979fd907 — normalize the wire `messages` value into the client's
// { text, by, at }[] shape, or undefined when it's absent/empty/malformed (so
// the client renders NOTHING and a message-less task looks exactly like today).
// Defensive + ORDER-PRESERVING (the server returns newest-last; we don't
// re-sort). Entries without usable `text` are dropped; `by`/`at` degrade to ''.
// `text` is DECRYPTED PHI and, like `notes`/`result`, rides in memory only — the
// skeleton store has no messages column, so it can never reach disk here.
export function mapMessages(messages) {
  if (!Array.isArray(messages)) return undefined;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const rec = m;
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
export function mapPendingQuestion(q) {
  if (!q || typeof q !== 'object') return undefined;
  const rec = q;
  const text = typeof rec.text === 'string' ? rec.text : '';
  if (!text) return undefined;
  const out = { text };
  if (Array.isArray(rec.options)) {
    const opts = rec.options.filter((o) => typeof o === 'string');
    if (opts.length) out.options = opts;
  }
  if (typeof rec.asked_by === 'string' && rec.asked_by) out.asked_by = rec.asked_by;
  if (typeof rec.asked_at === 'string' && rec.asked_at) out.asked_at = rec.asked_at;
  return out;
}

// Map a raw server agent row → the camelCase client `Agent`. Defensive (mirrors
// mapResult/mapMessages' "pass through ONLY when well-shaped" rule): a
// non-object or a row missing an id/name yields null, so a malformed entry is
// dropped rather than reaching the picker. `group` optional → null; `tools`
// coerced to string[] (non-array → []); `launchMode` passes through verbatim.
export function mapAgentRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!id || !name) return null;
  const group = typeof raw.group === 'string' && raw.group !== '' ? raw.group : null;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === 'string') : [];
  const launchMode = typeof raw.launch_mode === 'string' ? raw.launch_mode : '';
  return { id, name, group, tools, launchMode };
}

// The RESOLVED agent block inlined on get_task (detail.agent). Same shape + the
// same defensive mapping as a listed agent; null (dropped) when absent/malformed
// so a task with no/malformed agent maps exactly as today (NON-REGRESSION).
export function mapResolvedAgent(raw) {
  return mapAgentRow(raw);
}

// Normalize a raw step's field schema (inputs/outputs). Fail-soft: entries
// without a string `key` are dropped rather than rejecting the whole chain
// (same convention as mapOutputSchema).
export function mapChainFields(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const f of raw) {
    const key = f && typeof f.key === 'string' ? f.key : '';
    if (!key) continue;
    const field = { key };
    if (typeof f.label === 'string') field.label = f.label;
    if (typeof f.type === 'string') field.type = f.type;
    if (typeof f.required === 'boolean') field.required = f.required;
    out.push(field);
  }
  return out;
}

export function mapChainStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const titleTemplate = typeof raw.title_template === 'string' ? raw.title_template : '';
  if (!titleTemplate) return null;
  const step = { titleTemplate };
  if (typeof raw.body_template === 'string') step.bodyTemplate = raw.body_template;
  if (typeof raw.human_gate === 'boolean') step.humanGate = raw.human_gate;
  const inputs = mapChainFields(raw.inputs);
  if (inputs) step.inputs = inputs;
  const outputs = mapChainFields(raw.outputs);
  if (outputs) step.outputs = outputs;
  if (raw.needed_when != null) step.neededWhen = raw.needed_when;
  return step;
}

// Map a raw server chain row → the camelCase client `ChainDef`. A row missing
// an id (or with no usable steps) yields null (dropped) so a malformed entry
// never reaches the picker. Malformed individual steps are dropped.
export function mapChainRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const steps = [];
  for (const s of Array.isArray(raw.steps) ? raw.steps : []) {
    const step = mapChainStep(s);
    if (step) steps.push(step);
  }
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    steps,
    projectId: raw.project_id ?? null,
    groupId: raw.group_id ?? null,
    createdBy: raw.created_by ?? null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

// task-b1fe80e2669b (Phase 2) — the list endpoint now carries REAL server
// created_at/updated_at (ISO-'Z'). Use them. When the server omits them (an
// older deployment), fall back to `now` as the Phase-1 benign placeholder so
// the renderer's sorts/filters don't choke. This swap is STRICTLY BETTER for
// the attention floor (src/projects/attention.mjs): a real past `updated_at`
// is < the page-mount floor → counts as known activity (sawRealActivity),
// whereas the old now()-stamp was AT the floor → treated as unknown. A
// non-terminal row therefore no longer looks artificially "fresh" — it reads
// its true last-touch time. completed_at is still null unless terminal.
//
// `now` is INJECTED (defaults to Date.now()) so this stays pure/deterministic
// under test — the original inline call captured Date.now() once per call,
// which this default preserves for real callers.
export function mapListRow(row, now = Date.now()) {
  const raw = rawStatusOf(row);
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
    completed_at: status === 'done' || status === 'cancelled' ? (updatedMs ?? now) : null,
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
    maxAttempts: typeof row.max_attempts === 'number' ? row.max_attempts : undefined,
    // Local Task.flags is a required string[] (fm-b5at.7); default to [].
    flags: Array.isArray(row.flags) ? row.flags : [],
    // fm-lji6 (S2) — v2 fields. deferUntil keeps its full ISO (the snooze pill
    // needs the time to decide "in the future"); parentTaskId is opaque.
    deferUntil: row.defer_until ?? null,
    parentTaskId: row.parent_task_id ?? null,
    // task-ab1d7955e23f — owning project container (opaque, non-PHI).
    projectId: row.project_id ?? null,
    // Owning GROUP (opaque, non-PHI) — enables group-scoped relevance filtering
    // in the New Home data layer. Received on the list row; mapped through now.
    groupId: row.group_id ?? null,
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

// task-a7214605a998 — the create payload mapping, extracted so createTask AND
// bulkCreateTasks share ONE field mapping (a bulk create is createTask batched,
// not a second schema). Maps a TaskCreate to the server's /chromeext/tasks body
// (title/task/due_at/priority/project_id/agent_id/assigned_to/parent_task_id/
// depends_on/recurrence/output_schema/data). Fields are omitted when unset/empty
// so the payload is byte-identical to the plain create path (NON-REGRESSION).
// PHI: title/body/data ride in memory only, never logged.
export function buildCreatePayload(input) {
  const title = (input.title ?? '').trim();
  const body = (input.notes ?? '')?.trim() ?? '';
  const payload = { title, task: body };
  // due_at: the composer passes day-only or ISO; pass it straight through
  // (the server stores the ISO string verbatim). Omit when null/empty.
  if (input.due_at) payload.due_at = input.due_at;
  if (input.deferUntil) payload.defer_until = input.deferUntil;
  if (typeof input.priority === 'number') payload.priority = input.priority;
  // task-ab1d7955e23f — optional project container. Opaque id (non-PHI).
  if (input.projectId) payload.project_id = input.projectId;
  // Optional GROUP (server `group_id`) — the team the task is created into.
  // Opaque id (non-PHI). Sent from the composer's active group scope.
  if (input.groupId) payload.group_id = input.groupId;
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

// PATCH /chromeext/templates/{id} — edit a template's DEFINITION (task-
// 57e1470fad6f). Maps the client's camelCase `patch` (only the supplied
// fields are set) → the server's snake_case body: name, variables
// (full-replace), output_schema (full-replace), notes, agent_id, flags,
// project_id, group_id. Extracted from updateTemplate so the pure
// field-mapping (this function) is separable from the fetch/refresh side
// effects that stay in typebuild.ts.
export function buildTemplatePatchPayload(patch) {
  const payload = {};
  if (patch.name !== undefined) payload.name = patch.name;
  if (patch.variables !== undefined) payload.variables = patch.variables;
  if (patch.outputSchema !== undefined) payload.output_schema = patch.outputSchema;
  if (patch.notes !== undefined) payload.notes = patch.notes;
  if (patch.agentId !== undefined) payload.agent_id = patch.agentId;
  if (patch.flags !== undefined) payload.flags = patch.flags;
  if (patch.projectId !== undefined) payload.project_id = patch.projectId;
  if (patch.groupId !== undefined) payload.group_id = patch.groupId;
  return payload;
}
