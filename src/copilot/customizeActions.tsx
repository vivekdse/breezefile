// task-7bdb94445321 — CopilotKit actions for the Home Customize template:
// steps, approval rules, and chains. These are the write-side parity the
// audit found missing (the copilot could see the template but not edit its
// steps/approvals/chains).
//
// UNIFY, DON'T MIRROR: every action here calls the SAME pure ops in
// components/newhome/newHomeTemplateOps.ts that the inline editor
// (TemplateEditor.tsx) calls, then persists through the SAME newHomePrefs
// store and announces the change with the SAME 'fm:newhome:templateChanged'
// event NewHomePage already listens for. There is no second implementation of
// "add a step" / "reorder a chain entry".
//
// After a successful edit each action also opens the Customize panel on the
// relevant tab (fm:newhome:openCustomize), so it's visibly clear the copilot
// is operating the same surface the human sees.
//
// Scope: edits target the currently-selected Home project (nh.project) unless
// an explicit projectId is passed, matching customize_columns/add_template_field.
//
// PHI: field labels / step names / approval text / chain names are NON-PHI
// configuration (see newHomePrefs header); params/results are chat content the
// user authored — never additionally logged here.
import { useRef } from 'react';
import { z } from 'zod';
import { getTemplateConfig, setTemplateConfig } from '../components/newhome/newHomePrefs';
import * as ops from '../components/newhome/newHomeTemplateOps';
import { useNewHomeContext } from './newHomeContext';
import { immediateAction } from './actionKit';

const TEMPLATE_CHANGED_EVENT = 'fm:newhome:templateChanged';
const OPEN_CUSTOMIZE_EVENT = 'fm:newhome:openCustomize';

type Dir = -1 | 1;
function dirOf(direction: string): Dir | null {
  const d = direction.trim().toLowerCase();
  if (d === 'up' || d === 'earlier' || d === 'before') return -1;
  if (d === 'down' || d === 'later' || d === 'after') return 1;
  return null;
}

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <CopilotActions/> and <NavActions/>. */
export function CustomizeActions() {
  const nh = useNewHomeContext();
  // immediateAction registers each handler once — read live grounding through
  // a ref so the scope resolves against the CURRENT selected project, not the
  // first render's (see the same pattern in actions.tsx).
  const nhRef = useRef(nh);
  nhRef.current = nh;

  /** Scope an edit to the given project id, else the selected Home project,
   *  else the unscoped default. */
  function scopeOf(projectId?: string): string | null {
    return projectId?.trim() || nhRef.current.project?.id || null;
  }

  /** Persist + announce, then reveal the relevant Customize tab so the edit is
   *  visible. Returns the scope label for the confirmation string. */
  function commit(scopedId: string | null, cfg: ReturnType<typeof getTemplateConfig>, tab: string): string {
    setTemplateConfig(scopedId, cfg);
    window.dispatchEvent(new CustomEvent(TEMPLATE_CHANGED_EVENT, { detail: { projectId: scopedId } }));
    if (nhRef.current.surface === 'new-home') {
      window.dispatchEvent(new CustomEvent(OPEN_CUSTOMIZE_EVENT, { detail: { tab } }));
    }
    return scopedId ? `project ${scopedId}` : 'the default template';
  }

  // ─── Steps ─────────────────────────────────────────────────────────────

  /** Resolve a step by id first, then by exact (case-insensitive) name. */
  function findStep(cfg: ReturnType<typeof getTemplateConfig>, ref: string) {
    const r = ref.trim();
    const rl = r.toLowerCase();
    return (
      cfg.steps.find((s) => s.id === r) ??
      cfg.steps.find((s) => s.name.toLowerCase() === rl) ??
      null
    );
  }

  immediateAction({
    name: 'add_step',
    description:
      "Add a step to the project's task template. Steps are an ordered checklist/stage vocabulary; each can be automatic or gated on human approval.",
    parameters: z.object({
      name: z.string().describe('Step name.'),
      description: z.string().optional().describe('Optional step description.'),
      humanGate: z
        .boolean()
        .optional()
        .describe('True if this step requires human approval before proceeding (default false).'),
      projectId: z.string().optional().describe('Project to edit; defaults to the selected Home project.'),
    }),
    perform: ({ name, description, humanGate, projectId }) => {
      if (!name?.trim()) return 'Failed: a step name is required.';
      const scopedId = scopeOf(projectId);
      const cfg = ops.addStep(getTemplateConfig(scopedId), {
        name: name.trim(),
        description: description?.trim() ?? '',
        humanGate: !!humanGate,
      });
      const where = commit(scopedId, cfg, 'steps');
      return `Added step "${name.trim()}"${humanGate ? ' (human gate)' : ''} to ${where}.`;
    },
  });

  immediateAction({
    name: 'update_step',
    description:
      'Edit an existing template step (rename it, change its description, or toggle its human gate). Identify the step by name or id.',
    parameters: z.object({
      step: z.string().describe('The step to edit, by name or id.'),
      name: z.string().optional().describe('New name.'),
      description: z.string().optional().describe('New description.'),
      humanGate: z.boolean().optional().describe('Set the human-gate flag.'),
      projectId: z.string().optional(),
    }),
    perform: ({ step, name, description, humanGate, projectId }) => {
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findStep(cfg, step);
      if (!found) return `Failed: no step matches "${step}". Steps: ${cfg.steps.map((s) => s.name).join(', ') || '(none)'}.`;
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name.trim();
      if (description !== undefined) patch.description = description.trim();
      if (humanGate !== undefined) patch.humanGate = humanGate;
      if (Object.keys(patch).length === 0) return 'Failed: nothing to change — pass name, description, or humanGate.';
      const where = commit(scopedId, ops.updateStep(cfg, found.id, patch), 'steps');
      return `Updated step "${found.name}" in ${where}.`;
    },
  });

  immediateAction({
    name: 'remove_step',
    description: 'Remove a step from the template. Identify it by name or id.',
    parameters: z.object({
      step: z.string().describe('The step to remove, by name or id.'),
      projectId: z.string().optional(),
    }),
    perform: ({ step, projectId }) => {
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findStep(cfg, step);
      if (!found) return `Failed: no step matches "${step}".`;
      const where = commit(scopedId, ops.removeStep(cfg, found.id), 'steps');
      return `Removed step "${found.name}" from ${where}.`;
    },
  });

  immediateAction({
    name: 'move_step',
    description: "Reorder a step by moving it up (earlier) or down (later) one position.",
    parameters: z.object({
      step: z.string().describe('The step to move, by name or id.'),
      direction: z.string().describe('"up" or "down".'),
      projectId: z.string().optional(),
    }),
    perform: ({ step, direction, projectId }) => {
      const dir = dirOf(direction);
      if (!dir) return `Failed: direction must be "up" or "down" (got "${direction}").`;
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findStep(cfg, step);
      if (!found) return `Failed: no step matches "${step}".`;
      const where = commit(scopedId, ops.moveStep(cfg, found.id, dir), 'steps');
      return `Moved step "${found.name}" ${dir === -1 ? 'up' : 'down'} in ${where}.`;
    },
  });

  // ─── Approval rules ────────────────────────────────────────────────────

  immediateAction({
    name: 'add_approval_rule',
    description:
      'Add an approval-policy rule to the project (free-text guidance like "always ask before submitting over $1,000").',
    parameters: z.object({
      description: z.string().describe('The rule text.'),
      projectId: z.string().optional(),
    }),
    perform: ({ description, projectId }) => {
      if (!description?.trim()) return 'Failed: rule text is required.';
      const scopedId = scopeOf(projectId);
      const cfg = ops.addApprovalRule(getTemplateConfig(scopedId), description.trim());
      const where = commit(scopedId, cfg, 'approvals');
      return `Added approval rule to ${where}: "${description.trim()}".`;
    },
  });

  immediateAction({
    name: 'remove_approval_rule',
    description: 'Remove an approval rule, identified by its id or by its exact text.',
    parameters: z.object({
      rule: z.string().describe('The rule id, or its exact text.'),
      projectId: z.string().optional(),
    }),
    perform: ({ rule, projectId }) => {
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const r = rule.trim();
      const rl = r.toLowerCase();
      const found =
        cfg.approvalRules.find((x) => x.id === r) ??
        cfg.approvalRules.find((x) => x.description.toLowerCase() === rl) ??
        null;
      if (!found) return `Failed: no approval rule matches "${rule}".`;
      const where = commit(scopedId, ops.removeApprovalRule(cfg, found.id), 'approvals');
      return `Removed approval rule from ${where}.`;
    },
  });

  // ─── Chains ────────────────────────────────────────────────────────────

  function findChain(cfg: ReturnType<typeof getTemplateConfig>, ref: string) {
    const r = ref.trim();
    const rl = r.toLowerCase();
    const chains = cfg.chains ?? [];
    return chains.find((c) => c.id === r) ?? chains.find((c) => c.name.toLowerCase() === rl) ?? null;
  }

  immediateAction({
    name: 'add_chain',
    description:
      'Create a new chain — a reusable, ordered sequence of task-steps a project can later instantiate as linked tasks.',
    parameters: z.object({
      name: z.string().describe('Chain name.'),
      projectId: z.string().optional(),
    }),
    perform: ({ name, projectId }) => {
      if (!name?.trim()) return 'Failed: a chain name is required.';
      const scopedId = scopeOf(projectId);
      const { cfg } = ops.addChain(getTemplateConfig(scopedId), name.trim());
      const where = commit(scopedId, cfg, 'chains');
      return `Created chain "${name.trim()}" in ${where}.`;
    },
  });

  immediateAction({
    name: 'remove_chain',
    description: 'Delete a chain, identified by name or id.',
    parameters: z.object({
      chain: z.string().describe('The chain to delete, by name or id.'),
      projectId: z.string().optional(),
    }),
    perform: ({ chain, projectId }) => {
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findChain(cfg, chain);
      if (!found) return `Failed: no chain matches "${chain}".`;
      const where = commit(scopedId, ops.removeChain(cfg, found.id), 'chains');
      return `Deleted chain "${found.name}" from ${where}.`;
    },
  });

  immediateAction({
    name: 'rename_chain',
    description: 'Rename a chain.',
    parameters: z.object({
      chain: z.string().describe('The chain to rename, by name or id.'),
      name: z.string().describe('The new name.'),
      projectId: z.string().optional(),
    }),
    perform: ({ chain, name, projectId }) => {
      if (!name?.trim()) return 'Failed: a new name is required.';
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findChain(cfg, chain);
      if (!found) return `Failed: no chain matches "${chain}".`;
      const where = commit(scopedId, ops.renameChain(cfg, found.id, name.trim()), 'chains');
      return `Renamed chain "${found.name}" to "${name.trim()}" in ${where}.`;
    },
  });

  immediateAction({
    name: 'add_chain_step',
    description:
      "Append a step to a chain. titleTemplate becomes the created task's title when the chain is run; it may use {{n}} (1-based step index) and {{chain}} (the chain name).",
    parameters: z.object({
      chain: z.string().describe('The chain to add to, by name or id.'),
      titleTemplate: z.string().describe('Step title template, e.g. "Draft outreach #{{n}}".'),
      humanGate: z.boolean().optional().describe('Require human approval before this step (default false).'),
      projectId: z.string().optional(),
    }),
    perform: ({ chain, titleTemplate, humanGate, projectId }) => {
      if (!titleTemplate?.trim()) return 'Failed: a title template is required.';
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findChain(cfg, chain);
      if (!found) return `Failed: no chain matches "${chain}".`;
      const next = ops.addChainEntry(cfg, found.id, {
        titleTemplate: titleTemplate.trim(),
        humanGate: !!humanGate,
      });
      const where = commit(scopedId, next, 'chains');
      return `Added step "${titleTemplate.trim()}" to chain "${found.name}" in ${where}.`;
    },
  });

  /** Resolve a chain entry by id first, then by exact titleTemplate text. */
  function findChainEntry(chain: NonNullable<ReturnType<typeof findChain>>, ref: string) {
    const r = ref.trim();
    const rl = r.toLowerCase();
    return (
      chain.entries.find((e) => e.id === r) ??
      chain.entries.find((e) => e.titleTemplate.toLowerCase() === rl) ??
      null
    );
  }

  immediateAction({
    name: 'remove_chain_step',
    description: 'Remove a step from a chain. Identify the step by id or by its exact title template.',
    parameters: z.object({
      chain: z.string().describe('The chain, by name or id.'),
      step: z.string().describe('The chain step, by id or exact title template.'),
      projectId: z.string().optional(),
    }),
    perform: ({ chain, step, projectId }) => {
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findChain(cfg, chain);
      if (!found) return `Failed: no chain matches "${chain}".`;
      const entry = findChainEntry(found, step);
      if (!entry) return `Failed: no step in chain "${found.name}" matches "${step}".`;
      const where = commit(scopedId, ops.removeChainEntry(cfg, found.id, entry.id), 'chains');
      return `Removed a step from chain "${found.name}" in ${where}.`;
    },
  });

  immediateAction({
    name: 'move_chain_step',
    description: 'Reorder a step within a chain, up (earlier) or down (later).',
    parameters: z.object({
      chain: z.string().describe('The chain, by name or id.'),
      step: z.string().describe('The chain step, by id or exact title template.'),
      direction: z.string().describe('"up" or "down".'),
      projectId: z.string().optional(),
    }),
    perform: ({ chain, step, direction, projectId }) => {
      const dir = dirOf(direction);
      if (!dir) return `Failed: direction must be "up" or "down" (got "${direction}").`;
      const scopedId = scopeOf(projectId);
      const cfg = getTemplateConfig(scopedId);
      const found = findChain(cfg, chain);
      if (!found) return `Failed: no chain matches "${chain}".`;
      const entry = findChainEntry(found, step);
      if (!entry) return `Failed: no step in chain "${found.name}" matches "${step}".`;
      const where = commit(scopedId, ops.moveChainEntry(cfg, found.id, entry.id, dir), 'chains');
      return `Moved a step ${dir === -1 ? 'up' : 'down'} in chain "${found.name}" in ${where}.`;
    },
  });

  return null;
}
