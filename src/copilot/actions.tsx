// task-ce125a047c70 — Copilot actions + grounding, registered ONCE inside
// the CopilotKit provider so they're available from every surface (sidebar
// chat, wherever it's opened). Mount <CopilotActions /> inside the same
// <CopilotKit> that wraps CopilotSidebarPanel (see CopilotDock.tsx).
//
// Every action here talks to the SAME window.fm bridge / New Home prefs
// helpers the UI itself uses (src/bridge.ts, src/tasks.ts,
// src/components/newhome/newHomePrefs.ts) — no parallel copy of the
// create-task/create-project/template-edit logic. Mutations that New Home's
// own UI needs to react to (template edits, filter changes, "open this
// task") go out as `window` CustomEvents; NewHomePage.tsx listens for them
// (see the listeners added there) rather than this file reaching into New
// Home's React state directly. create_task is the one exception: it opens
// the canonical, globally-mounted TaskComposer (App.tsx, 'fm:openTask') —
// the same "New Task" form the task verb / Sidebar / Projects page open —
// rather than New Home's own NewTaskModal.
//
// PHI: action parameters/results are chat content already (the user typed
// them to the copilot) — never additionally logged here. Return short,
// unambiguous confirmation/error strings so the chat transcript is a clear
// audit trail of what actually happened.
import { useAgentContext } from '@copilotkit/react-core/v2';
import { z } from 'zod';
import { fm } from '../bridge';
import {
  getTemplateConfig,
  setTemplateConfig,
  type TemplateConfigExt,
} from '../components/newhome/newHomePrefs';
import type { TemplateField } from '../components/newhome/types';
import { useNewHomeContext } from './newHomeContext';
import { confirmedAction, immediateAction } from './actionKit';

const TEMPLATE_CHANGED_EVENT = 'fm:newhome:templateChanged';
const FILTER_EVENT = 'fm:newhome:filter';
const OPEN_TASK_EVENT = 'fm:newhome:openTask';
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

function dispatchTemplateChanged(projectId: string | null): void {
  window.dispatchEvent(new CustomEvent(TEMPLATE_CHANGED_EVENT, { detail: { projectId } }));
}

/** Mount once inside the CopilotKit provider (CopilotDock.tsx). Registers
 *  every action available app-wide plus the grounding readable — nothing
 *  here is scoped to the New Task modal (that's fill_field, registered
 *  separately + only while the modal is open — see NewTaskCopilotChat.tsx). */
export function CopilotActions() {
  const nh = useNewHomeContext();

  useAgentContext({
    description:
      "New Home grounding: which surface is focused, the currently selected New Home project (if any), " +
      "roster status counts, and the titles+ids of tasks that need a human right now (NOT full task bodies).",
    value: nh,
  });

  confirmedAction({
    name: 'create_task',
    description:
      'Create a new task. On approval this opens the New Task form pre-filled with the title/notes so the human can review and start it. Project-scoped when projectId is given (or omitted to use the currently selected New Home project from context).',
    parameters: z.object({
      title: z.string().describe('Short task title.'),
      notes: z.string().optional().describe('Optional task notes/body.'),
      projectId: z
        .string()
        .optional()
        .describe(
          'Optional project id to scope the task to. Defaults to the currently selected New Home project, if any.',
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

  immediateAction({
    name: 'customize_columns',
    description:
      "Set which columns show in a project's New Home roster table, and their order. Replaces the full column list.",
    parameters: z.object({
      projectId: z
        .string()
        .optional()
        .describe(
          'Project id to customize. Defaults to the currently selected New Home project, or the unscoped default when none is selected.',
        ),
      columns: z
        .array(z.string())
        .describe(
          "Column ids in display order (built-ins: title, status, who, lastAction, risk; or a custom field's key).",
        ),
    }),
    perform: async ({ projectId, columns }) => {
      if (!Array.isArray(columns) || columns.length === 0) {
        return 'Failed: at least one column is required.';
      }
      const scopedId = projectId || nh.project?.id || null;
      try {
        const cfg = getTemplateConfig(scopedId);
        const next: TemplateConfigExt = { ...cfg, columns };
        setTemplateConfig(scopedId, next);
        dispatchTemplateChanged(scopedId);
        return `Updated roster columns for ${scopedId ? `project ${scopedId}` : 'the default template'}: ${columns.join(', ')}.`;
      } catch (e) {
        return `Failed to update columns: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  confirmedAction({
    name: 'add_template_field',
    description:
      "Add a custom field to a project's New Task template (the fields the New Task interview asks about).",
    parameters: z.object({
      projectId: z
        .string()
        .optional()
        .describe(
          'Project id to add the field to. Defaults to the currently selected New Home project, or the unscoped default when none is selected.',
        ),
      key: z.string().describe('Machine-readable field key (e.g. "due_date").'),
      label: z.string().describe('Human-readable field label (e.g. "Due date").'),
      type: z.string().describe('Field type: one of text, date, select, number.'),
      required: z.boolean().optional().describe('Whether the field is required.'),
    }),
    title: 'Add template field?',
    summary: ({ projectId, key, label, type, required }) => {
      const scopedId = projectId || nh.project?.id || null;
      return (
        <>
          Add field <strong>{label}</strong> (<code>{key}</code>, type {String(type)}
          {required ? ', required' : ''}) to{' '}
          {scopedId ? (
            <>
              project <code>{scopedId}</code>
            </>
          ) : (
            'the default template'
          )}
          ?
        </>
      );
    },
    confirmLabel: 'Add field',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Cancelled — no field was added.',
    // Validation is preserved from the original handler; because it's pure and
    // side-effect-free it runs BEFORE the approve/reject card, so an invalid
    // request is rejected outright rather than asking the human to approve it.
    validate: ({ projectId, key, label, type }) => {
      const fieldType = type as TemplateField['type'];
      if (!['text', 'date', 'select', 'number'].includes(fieldType)) {
        return `Failed: type must be one of text, date, select, number (got "${type}").`;
      }
      if (!key?.trim() || !label?.trim()) {
        return 'Failed: both key and label are required.';
      }
      const scopedId = projectId || nh.project?.id || null;
      if (getTemplateConfig(scopedId).fields.some((f) => f.key === key)) {
        return `Failed: a field with key "${key}" already exists.`;
      }
      return null;
    },
    // Side effect — runs ONLY after Approve.
    perform: ({ projectId, key, label, type, required }) => {
      const fieldType = type as TemplateField['type'];
      const scopedId = projectId || nh.project?.id || null;
      const cfg = getTemplateConfig(scopedId);
      const field: TemplateField = {
        key: key.trim(),
        label: label.trim(),
        type: fieldType,
        required: !!required,
        agentFetchable: false,
      };
      const next: TemplateConfigExt = { ...cfg, fields: [...cfg.fields, field] };
      setTemplateConfig(scopedId, next);
      dispatchTemplateChanged(scopedId);
      return `Added field "${label}" (key: ${key}, type: ${fieldType}${required ? ', required' : ''}) to ${scopedId ? `project ${scopedId}` : 'the default template'}.`;
    },
  });

  immediateAction({
    name: 'set_roster_filter',
    description:
      'Filter the New Home roster table by status. Only takes effect when New Home is the focused surface.',
    parameters: z.object({
      filter: z.string().describe('One of: all, done, progress, queued, needs, failed.'),
    }),
    perform: async ({ filter }) => {
      if (!isFilterValue(filter)) {
        return `Failed: filter must be one of ${FILTER_VALUES.join(', ')} (got "${filter}").`;
      }
      if (nh.surface !== 'new-home') {
        return 'New Home is not currently open, so there is no roster to filter. Open New Home first.';
      }
      window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: { filter } }));
      return `Filtered the roster to "${filter}".`;
    },
  });

  immediateAction({
    name: 'open_task',
    description: 'Open a task\'s detail dialog in New Home by task id.',
    parameters: z.object({
      taskId: z.string().describe('The task id to open.'),
    }),
    perform: async ({ taskId }) => {
      if (!taskId?.trim()) return 'Failed: a task id is required.';
      if (nh.surface !== 'new-home') {
        return 'New Home is not currently open, so there is no task list to open a task in. Open New Home first.';
      }
      window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: { taskId } }));
      return `Opened task ${taskId}.`;
    },
  });

  return null;
}
