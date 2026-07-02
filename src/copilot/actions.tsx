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
// Home's React state directly.
//
// PHI: action parameters/results are chat content already (the user typed
// them to the copilot) — never additionally logged here. Return short,
// unambiguous confirmation/error strings so the chat transcript is a clear
// audit trail of what actually happened.
import { useCopilotAction, useCopilotReadable } from '@copilotkit/react-core';
import { createTask } from '../tasks';
import { fm } from '../bridge';
import {
  getTemplateConfig,
  setTemplateConfig,
  type TemplateConfigExt,
} from '../components/newhome/newHomePrefs';
import type { TemplateField } from '../components/newhome/types';
import { useNewHomeContext } from './newHomeContext';

const TEMPLATE_CHANGED_EVENT = 'fm:newhome:templateChanged';
const FILTER_EVENT = 'fm:newhome:filter';
const OPEN_TASK_EVENT = 'fm:newhome:openTask';

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

  useCopilotReadable({
    description:
      "New Home grounding: which surface is focused, the currently selected New Home project (if any), " +
      "roster status counts, and the titles+ids of tasks that need a human right now (NOT full task bodies).",
    value: nh,
  });

  useCopilotAction({
    name: 'create_task',
    description:
      'Create a new task. Project-scoped when projectId is given (or omitted to use the currently selected New Home project from context, or left blank for no project).',
    parameters: [
      { name: 'title', type: 'string', description: 'Short task title.', required: true },
      { name: 'notes', type: 'string', description: 'Optional task notes/body.', required: false },
      {
        name: 'projectId',
        type: 'string',
        description: 'Optional project id to scope the task to. Defaults to the currently selected New Home project, if any.',
        required: false,
      },
    ],
    handler: async ({ title, notes, projectId }) => {
      const trimmed = (title ?? '').trim();
      if (!trimmed) return 'Failed: a task title is required.';
      const resolvedProjectId = projectId || nh.project?.id;
      try {
        const task = await createTask({
          title: trimmed,
          folder: '',
          notes: notes || undefined,
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
        });
        return `Created task "${trimmed}" (id: ${task.id})${resolvedProjectId ? ` in project ${resolvedProjectId}` : ''}.`;
      } catch (e) {
        return `Failed to create task: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  useCopilotAction({
    name: 'create_project',
    description: 'Create a new TypeBuild project (a named task container).',
    parameters: [
      { name: 'name', type: 'string', description: 'Project name.', required: true },
      { name: 'description', type: 'string', description: 'Optional project description.', required: false },
    ],
    handler: async ({ name, description }) => {
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

  useCopilotAction({
    name: 'customize_columns',
    description:
      "Set which columns show in a project's New Home roster table, and their order. Replaces the full column list.",
    parameters: [
      {
        name: 'projectId',
        type: 'string',
        description: 'Project id to customize. Defaults to the currently selected New Home project, or the unscoped default when none is selected.',
        required: false,
      },
      {
        name: 'columns',
        type: 'string[]',
        description: "Column ids in display order (built-ins: title, status, who, lastAction, risk; or a custom field's key).",
        required: true,
      },
    ],
    handler: async ({ projectId, columns }) => {
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

  useCopilotAction({
    name: 'add_template_field',
    description:
      "Add a custom field to a project's New Task template (the fields the New Task interview asks about).",
    parameters: [
      {
        name: 'projectId',
        type: 'string',
        description: 'Project id to add the field to. Defaults to the currently selected New Home project, or the unscoped default when none is selected.',
        required: false,
      },
      { name: 'key', type: 'string', description: 'Machine-readable field key (e.g. "due_date").', required: true },
      { name: 'label', type: 'string', description: 'Human-readable field label (e.g. "Due date").', required: true },
      {
        name: 'type',
        type: 'string',
        description: 'Field type: one of text, date, select, number.',
        required: true,
      },
      { name: 'required', type: 'boolean', description: 'Whether the field is required.', required: false },
    ],
    handler: async ({ projectId, key, label, type, required }) => {
      const fieldType = type as TemplateField['type'];
      if (!['text', 'date', 'select', 'number'].includes(fieldType)) {
        return `Failed: type must be one of text, date, select, number (got "${type}").`;
      }
      if (!key?.trim() || !label?.trim()) {
        return 'Failed: both key and label are required.';
      }
      const scopedId = projectId || nh.project?.id || null;
      try {
        const cfg = getTemplateConfig(scopedId);
        if (cfg.fields.some((f) => f.key === key)) {
          return `Failed: a field with key "${key}" already exists.`;
        }
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
      } catch (e) {
        return `Failed to add field: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  useCopilotAction({
    name: 'set_roster_filter',
    description:
      'Filter the New Home roster table by status. Only takes effect when New Home is the focused surface.',
    parameters: [
      {
        name: 'filter',
        type: 'string',
        description: 'One of: all, done, progress, queued, needs, failed.',
        required: true,
      },
    ],
    handler: async ({ filter }) => {
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

  useCopilotAction({
    name: 'open_task',
    description: 'Open a task\'s detail dialog in New Home by task id.',
    parameters: [{ name: 'taskId', type: 'string', description: 'The task id to open.', required: true }],
    handler: async ({ taskId }) => {
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
