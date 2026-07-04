// task-ce125a047c70 — Copilot actions + grounding, registered ONCE inside
// the CopilotKit provider so they're available from every surface (sidebar
// chat, wherever it's opened). Mount <CopilotActions /> inside the same
// <CopilotKit> that wraps CopilotSidebarPanel (see CopilotDock.tsx).
//
// Every action here talks to the SAME window.fm bridge / Home prefs
// helpers the UI itself uses (src/bridge.ts, src/tasks.ts,
// src/components/newhome/newHomePrefs.ts) — no parallel copy of the
// create-task/create-project logic. Mutations that Home's own UI needs to
// react to (filter changes, "open this task") go out as `window`
// CustomEvents; NewHomePage.tsx listens for them (see the listeners added
// there) rather than this file reaching into New Home's React state
// directly. create_task is the one exception: it opens the canonical,
// globally-mounted TaskComposer (App.tsx, 'fm:openTask') — the same "New
// Task" form the task verb / Sidebar / Projects page open.
//
// PHI: action parameters/results are chat content already (the user typed
// them to the copilot) — never additionally logged here. Return short,
// unambiguous confirmation/error strings so the chat transcript is a clear
// audit trail of what actually happened.
import { useRef } from 'react';
import { useAgentContext } from '@copilotkit/react-core/v2';
import { z } from 'zod';
import { fm } from '../bridge';
import { compileTaskQuery, TASK_QUERY_FIELDS } from '../components/newhome/taskQuery';
import { useNewHomeContext } from './newHomeContext';
import { confirmedAction, immediateAction } from './actionKit';

const FILTER_EVENT = 'fm:newhome:filter';
const OPEN_TASK_EVENT = 'fm:newhome:openTask';
const SELECT_PROJECT_EVENT = 'fm:newhome:selectProject';
// create_task hands off to the real, canonical TaskComposer (the "New Task"
// form mounted globally in App.tsx and opened via 'fm:openTask' — the same
// form the task verb / Sidebar / Projects "+ New Task" open) instead of
// creating the task headlessly, so the human reviews/edits/submits through
// the actual form. The tool call resolves as soon as the form is OPENED, not
// once the human finishes it (a CopilotKit tool call must get a result
// promptly — see actionKit.tsx's perform() contract note) — the human then
// continues filling it in, and TaskComposer's own useCopilotReadable (see
// TaskComposer.tsx) keeps the chat aware of the form's live field values.
const OPEN_TASK_COMPOSER_EVENT = 'fm:openTask';

function openTaskComposer(prefill: { title: string; notes?: string; projectId?: string }): string {
  window.dispatchEvent(
    new CustomEvent(OPEN_TASK_COMPOSER_EVENT, {
      detail: {
        mode: 'create',
        defaultFolder: '',
        projectId: prefill.projectId,
        initialTitle: prefill.title,
        initialNotes: prefill.notes,
      },
    }),
  );
  return `Opened the New Task form pre-filled with "${prefill.title}" for the human to review and submit.`;
}

const FILTER_VALUES = ['all', 'done', 'progress', 'queued', 'needs', 'failed'] as const;
type FilterValue = (typeof FILTER_VALUES)[number];

function isFilterValue(v: string): v is FilterValue {
  return (FILTER_VALUES as readonly string[]).includes(v);
}

// task-a9841cfc0e1b — shared name-or-id resolution for the project CRUD
// actions below, mirroring select_home_project's own resolution (exact id →
// exact name → unambiguous substring) so "archive the Aetna project" and
// "select the Aetna project" behave consistently. Returns a structured
// result rather than throwing so each action can phrase its own error.
function resolveProjectRef(
  ref: string,
  list: { id: string; name: string }[],
): { ok: true; id: string; name: string } | { ok: false; error: string } {
  const raw = (ref ?? '').trim();
  if (!raw) return { ok: false, error: 'Failed: a project name or id is required.' };
  const ql = raw.toLowerCase();
  const subs = list.filter((p) => p.name.toLowerCase().includes(ql));
  const match =
    list.find((p) => p.id === raw) ??
    list.find((p) => p.name.toLowerCase() === ql) ??
    (subs.length === 1 ? subs[0] : null);
  if (!match) {
    if (subs.length > 1) {
      return { ok: false, error: `"${ref}" is ambiguous — matches ${subs.map((p) => p.name).join(', ')}. Be more specific.` };
    }
    return {
      ok: false,
      error: `Failed: no project matches "${ref}". Available: ${list.map((p) => p.name).join(', ') || '(none loaded)'}.`,
    };
  }
  return { ok: true, id: match.id, name: match.name };
}

/** Mount once inside the CopilotKit provider (CopilotDock.tsx). Registers
 *  every action available app-wide plus the grounding readable. */
export function CopilotActions() {
  const nh = useNewHomeContext();
  // immediateAction/confirmedAction register each handler ONCE, so a perform
  // closing over `nh` directly would capture the FIRST render's grounding —
  // e.g. availableProjects still empty before Home's data loads. Read the
  // live grounding through this ref instead (see FormCopilotBridge note).
  const nhRef = useRef(nh);
  nhRef.current = nh;

  useAgentContext({
    description:
      "Home grounding: which surface is focused, the currently selected Home project (if any), " +
      "the FULL list of projects the picker offers (availableProjects: id+name — use these with select_home_project), " +
      "roster status counts, the titles+ids of tasks that need a human right now (NOT full task bodies), " +
      "and `rosterFilter` — the roster's current status bucket + free-text search. Use set_roster_filter to change " +
      "either the status filter or the free-text search. A project carries no separate configuration — a chain is " +
      "defined inline when a task is created (or copied from an existing chained task), never edited via a project panel.",
    value: nh,
  });

  confirmedAction({
    name: 'create_task',
    description:
      'Create a new task. On approval this opens the New Task form pre-filled with the title/notes so the human can review and start it. Project-scoped when projectId is given (or omitted to use the currently selected Home project from context).',
    parameters: z.object({
      title: z.string().describe('Short task title.'),
      notes: z.string().optional().describe('Optional task notes/body.'),
      projectId: z
        .string()
        .optional()
        .describe(
          'Optional project id to scope the task to. Defaults to the currently selected Home project, if any.',
        ),
    }),
    title: 'Create task?',
    summary: ({ title, notes, projectId }) => {
      const resolved = projectId || nh.project?.id;
      return (
        <>
          Open the New Task form to create{' '}
          <strong>{(title ?? '').trim() || '(untitled)'}</strong>
          {resolved ? (
            <>
              {' '}in project <code>{resolved}</code>
            </>
          ) : null}
          ?
          {notes?.trim() ? <div className="ck-confirm-note">{notes.trim()}</div> : null}
        </>
      );
    },
    confirmLabel: 'Open New Task form',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Task creation cancelled.',
    validate: ({ title }) => {
      if (!(title ?? '').trim()) return 'Failed: a task title is required.';
      return null;
    },
    perform: ({ title, notes, projectId }) => {
      const trimmed = (title ?? '').trim();
      const resolvedProjectId = projectId || nh.project?.id;
      return openTaskComposer({
        title: trimmed,
        notes: notes?.trim() || undefined,
        projectId: resolvedProjectId || undefined,
      });
    },
  });

  immediateAction({
    name: 'create_project',
    description: 'Create a new TypeBuild project (a named task container).',
    parameters: z.object({
      name: z.string().describe('Project name.'),
      description: z.string().optional().describe('Optional project description.'),
    }),
    perform: async ({ name, description }) => {
      const trimmed = (name ?? '').trim();
      if (!trimmed) return 'Failed: a project name is required.';
      try {
        const project = await fm.typebuild.projects.create({
          name: trimmed,
          description: description || undefined,
        });
        return `Created project "${project.name}" (id: ${project.id}).`;
      } catch (e) {
        return `Failed to create project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // task-a9841cfc0e1b — project CRUD parity: the same fm.typebuild.projects.*
  // bridge the New Home UI's ProjectDialog/hero actions call (see
  // src/components/newhome/NewHomePage.tsx / ProjectDialog.tsx), so the
  // copilot and the UI share one mutation path, never a second
  // implementation. update/add_folder/remove_folder are reversible
  // (immediateAction); archive/unarchive are reversible too but still
  // confirmed since they change what's visible in the picker; delete is
  // confirmedAction + destructive (irreversible, and only for empty
  // projects — the server enforces that and a 409 surfaces as a clear
  // failure string here rather than a silent no-op).
  immediateAction({
    name: 'update_project',
    description:
      'Rename a project and/or edit its description or agent instructions (the teaching context an agent reads before working a task in it). Pass the project by name or id; only the fields given are changed.',
    parameters: z.object({
      project: z.string().describe('Project name or id (resolved against availableProjects).'),
      name: z.string().optional().describe('New name.'),
      description: z.string().optional().describe('New description.'),
      instructions: z.string().optional().describe('New agent instructions.'),
    }),
    perform: async ({ project, name, description, instructions }) => {
      const resolved = resolveProjectRef(project, nhRef.current.availableProjects);
      if (!resolved.ok) return resolved.error;
      if (name === undefined && description === undefined && instructions === undefined) {
        return 'Failed: nothing to change — set at least one of name, description, or instructions.';
      }
      try {
        const res = await fm.typebuild.projects.patch(resolved.id, {
          name: name?.trim() || undefined,
          description,
          instructions,
        });
        if (!res.ok) {
          if (res.reason === 'not_owner') return "Failed: you don't own this project.";
          if (res.reason === 'phi_rejected') {
            return 'Failed: that text looks like it may contain patient information.';
          }
          return `Failed to update project: ${res.reason}`;
        }
        return `Updated "${res.project.name}".`;
      } catch (e) {
        return `Failed to update project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  confirmedAction({
    name: 'archive_project',
    description:
      'Archive a project — hides it from the Home picker (reversible via unarchive_project). Pass the project by name or id.',
    parameters: z.object({
      project: z.string().describe('Project name or id (resolved against availableProjects).'),
    }),
    title: 'Archive project?',
    validate: ({ project }) => {
      const r = resolveProjectRef(project, nhRef.current.availableProjects);
      return r.ok ? null : r.error;
    },
    summary: ({ project }) => {
      const r = resolveProjectRef(project, nhRef.current.availableProjects);
      return (
        <>
          Archive <strong>{r.ok ? r.name : project}</strong>? It will be hidden from the picker
          until unarchived.
        </>
      );
    },
    confirmLabel: 'Archive',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — the project was not archived.',
    perform: async ({ project }) => {
      const resolved = resolveProjectRef(project, nhRef.current.availableProjects);
      if (!resolved.ok) return resolved.error;
      try {
        const updated = await fm.typebuild.projects.archive(resolved.id);
        return `Archived "${updated.name}".`;
      } catch (e) {
        return `Failed to archive project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  immediateAction({
    name: 'unarchive_project',
    description:
      'Restore a previously archived project so it shows in the Home picker again. Pass the project by name or id — the id/name must come from an archived-projects lookup, since availableProjects only lists non-archived projects.',
    parameters: z.object({
      projectId: z.string().describe('The archived project\'s id.'),
    }),
    perform: async ({ projectId }) => {
      if (!projectId?.trim()) return 'Failed: a project id is required.';
      try {
        const updated = await fm.typebuild.projects.unarchive(projectId.trim());
        return `Unarchived "${updated.name}".`;
      } catch (e) {
        return `Failed to unarchive project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  confirmedAction({
    name: 'delete_project',
    description:
      'Permanently delete a project. Only works on an EMPTY project (no tasks) — the server refuses otherwise and this reports that a project with tasks should be archived instead. Irreversible; requires human approval.',
    parameters: z.object({
      project: z.string().describe('Project name or id (resolved against availableProjects).'),
    }),
    title: 'Delete project?',
    destructive: true,
    validate: ({ project }) => {
      const r = resolveProjectRef(project, nhRef.current.availableProjects);
      return r.ok ? null : r.error;
    },
    summary: ({ project }) => {
      const r = resolveProjectRef(project, nhRef.current.availableProjects);
      return (
        <>
          Permanently delete <strong>{r.ok ? r.name : project}</strong>? Only allowed if it has no
          tasks. This can't be undone.
        </>
      );
    },
    confirmLabel: 'Delete',
    rejectLabel: 'Keep',
    rejectedMessage: 'Cancelled — the project was not deleted.',
    perform: async ({ project }) => {
      const resolved = resolveProjectRef(project, nhRef.current.availableProjects);
      if (!resolved.ok) return resolved.error;
      try {
        const res = await fm.typebuild.projects.delete(resolved.id);
        if (!res.ok) {
          if (res.reason === 'has_tasks') {
            return `"${resolved.name}" still has tasks — archive it instead of deleting.`;
          }
          if (res.reason === 'not_owner') return "Failed: you don't own this project.";
          return `Failed to delete project: ${res.reason}`;
        }
        return `Deleted "${resolved.name}".`;
      } catch (e) {
        return `Failed to delete project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  immediateAction({
    name: 'add_project_folder',
    description: 'Attach a folder path to a project. Pass the project by name or id.',
    parameters: z.object({
      project: z.string().describe('Project name or id (resolved against availableProjects).'),
      folder: z.string().describe('Absolute folder path to attach.'),
    }),
    perform: async ({ project, folder }) => {
      const resolved = resolveProjectRef(project, nhRef.current.availableProjects);
      if (!resolved.ok) return resolved.error;
      const path = (folder ?? '').trim();
      if (!path) return 'Failed: a folder path is required.';
      try {
        const updated = await fm.typebuild.projects.addFolder(resolved.id, path);
        return `Attached "${path}" to "${updated.name}".`;
      } catch (e) {
        return `Failed to attach folder: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  immediateAction({
    name: 'remove_project_folder',
    description: 'Detach a folder path from a project. Pass the project by name or id.',
    parameters: z.object({
      project: z.string().describe('Project name or id (resolved against availableProjects).'),
      folder: z.string().describe('The exact folder path to detach.'),
    }),
    perform: async ({ project, folder }) => {
      const resolved = resolveProjectRef(project, nhRef.current.availableProjects);
      if (!resolved.ok) return resolved.error;
      const path = (folder ?? '').trim();
      if (!path) return 'Failed: a folder path is required.';
      try {
        const updated = await fm.typebuild.projects.removeFolder(resolved.id, path);
        return `Detached "${path}" from "${updated.name}".`;
      } catch (e) {
        return `Failed to detach folder: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  immediateAction({
    name: 'set_roster_filter',
    description:
      'Filter the Home roster table by status AND/OR a free-text search. Pass `filter` for the status bucket, `search` for arbitrary text (matched case-insensitively across task titles, status, who, last-action, and custom-field values — every whitespace-separated word must match). The two combine (AND). Pass search="" to clear the text search; omit a param to leave that dimension unchanged. At least one of filter/search is required. Only takes effect when Home is the focused surface.',
    parameters: z.object({
      filter: z
        .string()
        .optional()
        .describe('Status bucket: one of all, done, progress, queued, needs, failed.'),
      search: z
        .string()
        .optional()
        .describe('Free-text query to match against tasks (e.g. "insurance", "jane doe"). Empty string clears it.'),
    }),
    perform: async ({ filter, search }) => {
      if (filter === undefined && search === undefined) {
        return 'Failed: pass a status `filter`, a `search` string, or both.';
      }
      if (filter !== undefined && !isFilterValue(filter)) {
        return `Failed: filter must be one of ${FILTER_VALUES.join(', ')} (got "${filter}").`;
      }
      if (nhRef.current.surface !== 'new-home') {
        return 'Home is not currently open, so there is no roster to filter. Open Home first.';
      }
      const detail: { filter?: string; search?: string } = {};
      if (filter !== undefined) detail.filter = filter;
      if (search !== undefined) detail.search = search;
      window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail }));
      const parts: string[] = [];
      if (filter !== undefined) parts.push(`status "${filter}"`);
      if (search !== undefined) parts.push(search ? `search "${search}"` : 'cleared search');
      return `Filtered the roster: ${parts.join(' + ')}.`;
    },
  });

  immediateAction({
    name: 'query_roster',
    description:
      'Filter the Home roster with a STRUCTURED, SQL-like query over task fields (more precise than set_roster_filter\'s free-text search). ' +
      'Grammar: boolean `and`/`or`/`not` + parens; comparisons `field op value` (op ∈ = != > < >= <= ~ !~, where ~ / !~ are regex); ' +
      '`field in (a, b, c)`; `field between lo and hi`; `field glob "pat"`; a bare bool field is a truthiness test. ' +
      'Time fields accept `now`, `now-2h`, `now+7d`, and ISO dates. ' +
      'Base fields: ' +
      TASK_QUERY_FIELDS.map((f) => `${f.name} (${f.kind})`).join(', ') +
      '. Examples: `status = needs and repeatable`; `status in (needs, failed) and risk ~ retry`; `due between now and now+7d`. ' +
      'Pass an empty query to clear. Only takes effect when Home is the focused surface.',
    parameters: z.object({
      query: z.string().describe('The structured query, or "" to clear.'),
    }),
    perform: async ({ query }) => {
      if (nhRef.current.surface !== 'new-home') {
        return 'Home is not currently open, so there is no roster to query. Open Home first.';
      }
      const q = (query ?? '').trim();
      if (!q) {
        window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: { search: '' } }));
        return 'Cleared the roster query.';
      }
      // Validate against the base task-field catalogue so a bad field/syntax
      // comes straight back to the model instead of silently matching
      // nothing. Same compile the roster uses (one engine). Projects declare
      // no extra queryable fields anymore (task-b1fa5098da3e).
      const compiled = compileTaskQuery(q, []);
      if (!compiled.ok) {
        return `Failed: invalid query — ${compiled.error}.`;
      }
      window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: { search: q } }));
      return `Applied roster query: ${q}`;
    },
  });

  immediateAction({
    name: 'select_home_project',
    description:
      "Scope Home to a project — this drives the project picker at the top of the page. Pass the project's NAME or id (resolved against availableProjects in the grounding), or \"all\" / \"\" to show All projects. Only takes effect when Home is the focused surface.",
    parameters: z.object({
      project: z.string().describe('Project name or id, or "all"/"" for All projects.'),
    }),
    perform: async ({ project }) => {
      const ctx = nhRef.current;
      if (ctx.surface !== 'new-home') {
        return 'Home is not currently open. Open Home first, then pick a project.';
      }
      const raw = (project ?? '').trim();
      const ql = raw.toLowerCase();
      if (!raw || ql === 'all' || ql === 'all projects') {
        window.dispatchEvent(new CustomEvent(SELECT_PROJECT_EVENT, { detail: { projectId: null } }));
        return 'Scoped Home to All projects.';
      }
      const list = ctx.availableProjects;
      const subs = list.filter((p) => p.name.toLowerCase().includes(ql));
      const match =
        list.find((p) => p.id === raw) ??
        list.find((p) => p.name.toLowerCase() === ql) ??
        (subs.length === 1 ? subs[0] : null);
      if (!match) {
        if (subs.length > 1) {
          return `"${project}" is ambiguous — matches ${subs.map((p) => p.name).join(', ')}. Be more specific.`;
        }
        return `Failed: no project matches "${project}". Available: ${list.map((p) => p.name).join(', ') || '(none loaded)'}.`;
      }
      window.dispatchEvent(new CustomEvent(SELECT_PROJECT_EVENT, { detail: { projectId: match.id } }));
      return `Scoped Home to "${match.name}".`;
    },
  });

  immediateAction({
    name: 'open_task',
    description: 'Open a task\'s detail dialog in Home by task id.',
    parameters: z.object({
      taskId: z.string().describe('The task id to open.'),
    }),
    perform: async ({ taskId }) => {
      if (!taskId?.trim()) return 'Failed: a task id is required.';
      if (nhRef.current.surface !== 'new-home') {
        return 'Home is not currently open, so there is no task list to open a task in. Open Home first.';
      }
      window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: { taskId } }));
      return `Opened task ${taskId}.`;
    },
  });

  return null;
}
