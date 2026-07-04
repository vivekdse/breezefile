// task-a9ba4a7b5a39 — ONE general, read-only data-retrieval action for the
// copilot. Instead of hand-writing a bespoke `find_X` per entity type, this
// gives the model a single `query_data` it points at an ENTITY TYPE, and it
// routes to the SAME read path the UI already uses for that type:
//
//   tasks    → the full task roster (useNewHomeData), filtered by the existing
//              no-eval task DSL (compileTaskQuery/runTaskQuery — one engine,
//              the same one query_roster + the roster search box use).
//   projects → fm.typebuild.projects.list(), field-substring filtered.
//   agents   → fm.typebuild.agents.list(), field-substring filtered.
//
// "Unify, don't mirror": no parallel query language, no reimplemented reads.
// External DataSource ENTITIES (rows behind a registered API) are NOT reachable
// from a local list — they only exist as SavedQuery output. Rather than invent a
// second, unsandboxed path here, query_data steers the model to the existing
// SavedQuery actions (list_data_sources / draft_saved_query / test_saved_query),
// which run in the server-side sandbox with its timeout/fetch/row caps. This
// action stays READ-ONLY: mutations remain on the gated task actions.
//
// PHI: task titles/fields may be PHI. They are chat content the user is asking
// to see — returning the user's OWN data to the transcript is acceptable (same
// as find_tasks) — but rows are NEVER logged/persisted here, and the query
// mechanism reaches only the signed-in user's already-loaded local data (no
// cross-tenant reach, no arbitrary I/O). Results are hard-capped (MAX_ROWS).
import { useRef } from 'react';
import { z } from 'zod';
import { fm } from '../bridge';
import { useNewHomeData } from '../components/newhome/useNewHomeData';
import {
  compileTaskQuery,
  runTaskQuery,
  TASK_QUERY_FIELDS,
} from '../components/newhome/taskQuery';
import type { NewHomeTask } from '../components/newhome/types';
import type { Project, Agent } from '../types';
import { immediateAction } from './actionKit';

// A single scan must never dump the whole inventory into the transcript — cap
// rows the same way find_tasks does (unbounded output is both a token and a
// PHI-surface risk). The model pages by narrowing the query, not by raising this.
const MAX_ROWS = 50;
const DEFAULT_ROWS = 20;

const ENTITY_TYPES = ['tasks', 'projects', 'agents'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

function isEntityType(v: string): v is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(v);
}

/** Case-insensitive substring match of `needle` against any of `haystacks`. */
function matchesText(needle: string, haystacks: (string | null | undefined)[]): boolean {
  const q = needle.toLowerCase();
  return haystacks.some((h) => (h ?? '').toLowerCase().includes(q));
}

function taskLine(t: NewHomeTask): string {
  return `- "${t.title}" [${t.status}] id=${t.id}${t.projectId ? ` project=${t.projectId}` : ''}`;
}

function projectLine(p: Project): string {
  const bits = [`id=${p.id}`];
  if (p.archived) bits.push('archived');
  if (p.folders.length) bits.push(`folders=${p.folders.length}`);
  return `- "${p.name}" (${bits.join(' ')})`;
}

function agentLine(a: Agent): string {
  const bits = [`id=${a.id}`, `launch=${a.launchMode}`];
  if (a.group) bits.push(`group=${a.group}`);
  if (a.tools.length) bits.push(`tools=${a.tools.join('/')}`);
  return `- "${a.name}" (${bits.join(' ')})`;
}

function render(kind: string, total: number, lines: string[]): string {
  const shown = lines.slice(0, MAX_ROWS);
  const more =
    total > shown.length ? `\n(+${total - shown.length} more — narrow the query)` : '';
  return `Found ${total} ${kind}:\n${shown.join('\n')}${more}`;
}

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside the
 *  other <...Actions/>. Registers the single general read action. */
export function QueryDataActions() {
  // The tasks entity queries the SAME roster the DSL is built for (NewHomeTask
  // rows carry the derived who/needs_answer/last_action fields the DSL fields
  // reference) — not a parallel task read. Projects/agents come from the same
  // bridge lists the UI uses. includeDone so the model can reach ANY task.
  const home = useNewHomeData();

  // STALE-CLOSURE NOTE (see actions.tsx / taskActions.tsx): immediateAction
  // registers the handler ONCE, so closing over `home` directly would capture
  // the first render's EMPTY roster (data loads async). Read through a ref
  // refreshed each render so the handler always sees the current inventory.
  const live = useRef(home);
  live.current = home;

  immediateAction({
    name: 'query_data',
    description:
      'Retrieve read-only data of ANY supported type — use this instead of asking for a bespoke find_X. ' +
      'Set `entity` to one of: tasks, projects, agents. ' +
      'For entity="tasks" pass `query`: a STRUCTURED query over task fields (same grammar as query_roster) — ' +
      'boolean and/or/not + parens; `field op value` (op ∈ = != > < >= <= ~ !~, ~/!~ regex); `field in (a,b,c)`; ' +
      '`field between lo and hi`; `field glob "pat"`; a bare bool field is a truthiness test; time fields accept now / now-2h / now+7d / ISO dates. ' +
      'Task fields: ' +
      TASK_QUERY_FIELDS.map((f) => `${f.name} (${f.kind})`).join(', ') +
      '. For entity="projects"/"agents" pass `query` as free-text matched case-insensitively across the name (and id/folders/tools) — or omit it to list all. ' +
      'Returns rows (capped) with ids so you can then act on them. READ-ONLY. ' +
      'To query EXTERNAL data behind a registered API (patients, claims, any DataSource entity), do NOT use this — use list_data_sources then draft_saved_query / test_saved_query, which run in the sandbox.',
    parameters: z.object({
      entity: z.string().describe('What to retrieve: tasks, projects, or agents.'),
      query: z
        .string()
        .optional()
        .describe(
          'For tasks: a structured field query (see grammar above). For projects/agents: free-text to match by name. Omit to list all.',
        ),
      limit: z
        .number()
        .optional()
        .describe(`Max rows to return (default ${DEFAULT_ROWS}, hard max ${MAX_ROWS}).`),
    }),
    perform: async ({ entity, query, limit }) => {
      const kind = (entity ?? '').trim().toLowerCase();
      if (!isEntityType(kind)) {
        return `Failed: entity must be one of ${ENTITY_TYPES.join(', ')} (got "${entity}"). For external API data use list_data_sources + draft_saved_query instead.`;
      }
      const cap = Math.max(1, Math.min(limit ?? DEFAULT_ROWS, MAX_ROWS));
      const q = (query ?? '').trim();

      if (kind === 'tasks') {
        const tasks = live.current.tasks;
        let matches = tasks;
        if (q) {
          // Same no-eval DSL the roster uses — a bad field/syntax comes
          // straight back to the model instead of silently matching nothing.
          const compiled = compileTaskQuery(q, []);
          if (!compiled.ok) {
            return `Failed: invalid task query — ${compiled.error}. Fields: ${TASK_QUERY_FIELDS.map((f) => f.name).join(', ')}.`;
          }
          matches = runTaskQuery(tasks, compiled.compiled, Date.now());
        }
        if (!matches.length) {
          return q ? `No tasks match \`${q}\`.` : 'No tasks found.';
        }
        return render('task(s)', matches.length, matches.slice(0, cap).map(taskLine));
      }

      if (kind === 'projects') {
        let projects: Project[];
        try {
          projects = await fm.typebuild.projects.list();
        } catch (e) {
          return `Failed to list projects: ${e instanceof Error ? e.message : String(e)}`;
        }
        let matches = projects;
        if (q) {
          matches = projects.filter((p) => matchesText(q, [p.name, p.id, ...p.folders]));
        }
        if (!matches.length) {
          return q ? `No projects match "${q}".` : 'No projects found.';
        }
        return render('project(s)', matches.length, matches.slice(0, cap).map(projectLine));
      }

      // agents
      let agents: Agent[];
      try {
        agents = await fm.typebuild.agents.list();
      } catch (e) {
        return `Failed to list agents: ${e instanceof Error ? e.message : String(e)}`;
      }
      let matches = agents;
      if (q) {
        matches = agents.filter((a) => matchesText(q, [a.name, a.id, a.group, ...a.tools]));
      }
      if (!matches.length) {
        return q ? `No agents match "${q}".` : 'No agents found.';
      }
      return render('agent(s)', matches.length, matches.slice(0, cap).map(agentLine));
    },
  });

  return null;
}
