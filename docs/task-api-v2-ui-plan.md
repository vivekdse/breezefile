# Task API v2 — Breeze UI update plan

**Status:** Plan approved 2026-06-12 (fm-ectx, under epic fm-r8vj). Child beads filed per slice.
**Server contract:** TypeBuild Task API v2, live at `https://general.typebuild.com` since
2026-06-11. Sources of truth: Swagger at `/docs`, plus `docs/task-api-v2-spec.md` and
`docs/MCP_TOOLS.md` in `small_business_software/software/task_manager_api`.
**Scope:** the TypeBuild leg only (`electron/sources/typebuild.ts` and the task UI).
Local/breezed tasks are untouched.

---

## 0. Contract reconciliation (do this first — it unblocks everything)

The server and this client drifted while both sides moved:

1. **`POST /chromeext/{id}/complete` does not exist and never will.** Our
   `complete()` (typebuild.ts) and `docs/typebuild-complete-endpoint.md` spec'd an
   endpoint the server replaced with a general management verb:
   **`PATCH /chromeext/{id}` with `{status: 'done'|'partial'|'cancelled'|'blocked'|'open'}`.**
   The server enforces a transition table (409 + reason on illegal), clears claims,
   and records an override submission. Replace `complete()` with a `patchTask()`
   client; mark `docs/typebuild-complete-endpoint.md` superseded by this doc.
2. **Reopen-from-done** (deliberately deferred in `primaryAction.mjs:16,91`,
   `RowKebabMenu.tsx:9`): do NOT extend `/reopen` — that endpoint stays
   blocked-only by design. Reopen-from-done/cancelled/failed is
   `PATCH {status:'open'}` (also resets attempts, clears last error).
3. **`cancelled` is now a real server status** (terminal, hidden from default
   lists). Today `mapStatus` (typebuild.ts:120) would collapse it to `pending` and
   `sections.mjs:25` / `primaryAction.mjs:29` would not treat it as terminal — a
   cancelled task would sit in FOR AGENTS with a Start button. Map server
   `cancelled` → local `cancelled` and add it to both terminal sets.
4. **New 409/400 reason vocabulary** (pass-through today, unfriendly):
   `use_claim_task`, `failed_is_agent_outcome`, `illegal_transition`,
   `bad_status`, `not_ready` (carries `blocked_by: [task ids]`), `last_admin`,
   `in_progress_elsewhere`, `not_owner`. Humanize in `src/errorMessages.ts`.

## 1. New server surface relevant to Breeze

| Capability | Endpoint | UI home |
|---|---|---|
| Mark done / cancel / block / reopen, edit priority, assigned_to, due_at, defer_until, max_attempts, parent_task_id, depends_on | `PATCH /chromeext/{id}` | detail-panel Lifecycle row, kebab, status chips |
| List filters + pagination | `GET /chromeext/tasks?status=&claimed_by=me&group_id=&assigned_to=&parent=&limit=&offset=` | poller + filter bar |
| New list/detail fields | `due_at`, `defer_until`, `parent_task_id` (list+detail); `depends_on`, `deps_satisfied`, `blocked_by` (detail) | row + detail |
| Claim next | `POST /chromeext/tasks/claim-next` (409 `no_open_tasks`) | "Start next" affordance (later) |
| Bulk create (parent + ≤50 children) | `POST /chromeext/tasks/bulk` | composer (later) |
| Delete task | `DELETE /chromeext/{id}` (creator-only; 403 `not_owner`, 409 `in_progress_elsewhere`) | kebab + confirm |
| Users registry | `GET /chromeext/users` | assignee picker |
| Per-task audit history | `GET /chromeext/audit?task_id=&limit=` | detail panel |
| Claim renewal | re-`POST /claim` by holder, or task note, extends the 2h TTL | session keep-alive |

Skills, groups, lessons, skill-version endpoints: Breeze has no UI for these today;
**out of scope** for this epic (revisit when a skills browser is wanted).

## 2. Slices (one child bead each, under fm-r8vj)

### S1 — v2 verb adapter + status correctness (P1, foundation)
`electron/sources/typebuild.ts`: add `patchTask(id, body)`; reimplement `complete`
on it (`{status:'done'}`), add `cancel` (`{status:'cancelled'}`) and
reopen-from-terminal (`{status:'open'}`); keep `/claim`, `/release`, `/reopen`
(blocked) as-is. Map server `cancelled`; fix terminal sets (`sections.mjs`,
`primaryAction.mjs`); add `cancelled` to `RAW_ORDER`. Surface the new actions:
detail Lifecycle row gains Cancel; Reopen appears for done/cancelled/failed via
PATCH; kebab parity. Remove the `complete-unsupported` degrade path (route is
real now). Reason strings → `errorMessages.ts`. Tests: extend
`tests/tasks-primary-action.test.mjs` / `tasks-sections.test.mjs` for cancelled +
reopen-from-done.

### S2 — v2 fields on list/detail + claimed-by-me (P1)
Map `due_at`, `defer_until`, `parent_task_id` in `mapListRow`/`mapDetail`
(typebuild.ts:142/:326) → `SourcedTask` (task-source.ts:40) → `Task`
(src/types.ts:149; TypeBuild rows populate the existing `due_at`). Detail adds
`depends_on`/`deps_satisfied`/`blocked_by` (memory-only, like the body). Row: due
date pill reuses the local-task rendering; deferred tasks get a snooze-style pill.
Filter bar: "Mine" toggle backed by `?claimed_by=me`; "Show done" passes
`all=1` as today and now also shows cancelled. Wire the existing-but-unconsumed
`onTaskSourceError` (preload.ts:311) into the status line.

### S3 — parent/child + dependency presentation (P2)
Group child rows under their parent in FOR AGENTS (indent, parent shows
child-progress count); parent rows lose Start (server won't hand out containers).
`not_ready` claim rejection renders "waiting on N tasks" with the `blocked_by`
ids resolvable to titles from the list cache. Keep `sections.mjs` pure; partition
logic gets unit tests.

### S4 — assignment + users (P2)
`GET /chromeext/users` (new `TypeBuildTaskSource` read + IPC). Detail panel:
assignee row (render `assigned_to`, already received-but-unmapped) with a picker
→ `PATCH {assigned_to}`; priority becomes editable (stepper) → `PATCH {priority}`.

### S5 — composer: due/defer/priority for TypeBuild creates (P2)
`TaskComposer.tsx`: when target = TypeBuild, the existing due/"when" step writes
`due_at`/`defer_until`, plus priority. Bulk parent+children creation deferred to a
follow-up bead (needs composer multi-row UX thought).

### S6 — delete + destructive-action handling (P3)
Kebab "Delete…" for TypeBuild rows through the existing `fm:confirm` flow
(`destructive: true`); handle 403 `not_owner` / 409 `in_progress_elsewhere`
distinctly in the status line.

### S7 — audit history in detail (P3)
Lazy "History" section in `AgentDetail`: `GET /chromeext/audit?task_id=&limit=20`
(actions are non-PHI; render actor, action, detail, time). Memory-only.

### S8 — claim keep-alive during Start sessions (P3)
While a Breeze-launched Claude session for task X is alive past ~90 min, re-claim
once to renew the TTL (typebuild.ts owns the timer; stop on session exit).

## 3. Invariants
- **PHI:** decrypted titles/bodies, notes, deps context: main/renderer memory
  only — never `tasks.db`, localStorage, logs, or notifications (unchanged).
- 30s poll + optimistic patch overlay (`src/tasks.ts`) stays the data model; every
  new mutation goes through `patchCacheAndBroadcast` + `recordPendingPatch`.
- Pure logic (`sections.mjs`, `primaryAction.mjs`) stays plain-mjs + `node --test`.
- Quality gate per slice: `npm run typecheck && npm test && npm run build`.
