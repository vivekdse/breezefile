// task-c60ae2a41e71 / task-7bdb94445321 — Customize editor: field / column /
// approval-rule / step / chain editor + a read-only form preview.
//
// task-7bdb94445321 reworked this from a MODAL with an internal draft + Save
// button into an INLINE, LIVE-APPLY panel: it renders in the New Home page
// flow (not an overlay), holds no draft of its own, and reports every edit up
// through `onChange` immediately (NewHomePage persists to newHomePrefs and
// re-reads). Because there's no private draft, a CopilotKit action editing the
// same persisted config shows up here instantly, and the grounding the copilot
// reads always matches what's on screen — one source of truth, no mirroring.
// All mutations go through the shared pure ops in newHomeTemplateOps.ts (the
// SAME ops the copilot calls).
//
// Ownership: this file, TemplateEditor.css, newHomePrefs.ts, ChainStrip.tsx/
// .css, and newHomeTemplateOps.ts. Chains ride on the local `TemplateConfigExt`
// extension (newHomePrefs.ts), not the shared `TemplateConfig`.
import { useEffect, useMemo, useState } from 'react';
import type { TemplateField, TaskDef, TaskDefField, TaskDefCondition } from './types';
import type { TemplateConfigExt } from './newHomePrefs';
import { ChainStrip, type ChainStripStep } from './ChainStrip';
import { listApprovedQueries, type SavedQuerySummary } from '../../copilot/savedQueries';
import * as ops from './newHomeTemplateOps';
import './TemplateEditor.css';

export type CustomizeTab =
  | 'tasks'
  | 'fields'
  | 'columns'
  | 'approvals'
  | 'steps'
  | 'chains'
  | 'repeatable'
  | 'preview';

// task-af3a8fdc8974 — the Tasks tab is the primary/forward way to author a
// template (an ordered chain of TaskDefs). The Repeatable/Chains/Steps tabs are
// LEGACY: kept rendering so existing templates don't break, but superseded by
// Tasks. Fields/Columns/Approvals/Preview are unchanged.
const TABS: { id: CustomizeTab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'fields', label: 'Fields' },
  { id: 'columns', label: 'Columns' },
  { id: 'repeatable', label: 'Repeatable Tasks' },
  { id: 'chains', label: 'Chains' },
  { id: 'steps', label: 'Steps' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'preview', label: 'Preview' },
];

// A field key must be a slug ([a-z0-9._-]+, see types.ts / docs). Used to flag
// an invalid key inline in the task-def field editor.
const KEY_PATTERN = /^[a-z0-9._-]+$/;
/** Coerce free text toward the slug charset as the user types (lowercase, only
 *  [a-z0-9._-]) so an edited key stays valid without fighting the user. */
function sanitizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}
/** Split a TaskDefCondition.ref ("<taskDefId>.<outputKey>") into its parts.
 *  taskDef ids are uid()-generated (hyphens, never dots), while an output key
 *  may itself contain a dot — so split on the FIRST dot: everything before it
 *  is the id, everything after is the key. */
function splitRef(ref: string): { taskDefId: string; key: string } {
  const i = ref.indexOf('.');
  if (i < 0) return { taskDefId: ref, key: '' };
  return { taskDefId: ref.slice(0, i), key: ref.slice(i + 1) };
}
const COND_OPS: TaskDefCondition['op'][] = ['==', '!=', '<', '>'];

const BUILTIN_COLUMNS = [
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'who', label: 'Who' },
  { id: 'lastAction', label: 'Last action' },
  { id: 'risk', label: 'Risk' },
];

export function TemplateEditor({
  projectId,
  config,
  onChange,
  onClose,
  tab,
  onTabChange,
  onRunRepeatable,
  onRunChain,
}: {
  projectId: string;
  /** The persisted config (already the extended shape, chains included). This
   *  component renders straight off it — no internal draft. */
  config: TemplateConfigExt;
  /** Report a mutated config up; the parent persists + re-reads so this panel
   *  and any copilot grounding stay in lockstep. */
  onChange: (cfg: TemplateConfigExt) => void;
  onClose: () => void;
  /** Controlled active tab so a copilot "open Customize on the Steps tab"
   *  action can drive it (see NewHomePage's fm:newhome:openCustomize). */
  tab: CustomizeTab;
  onTabChange: (tab: CustomizeTab) => void;
  /** Spawn a real task from a repeatable-task definition ("Run now"). The
   *  parent owns task creation (createTask + refresh); this panel only asks. */
  onRunRepeatable: (id: string) => void;
  /** Instantiate a chain into linked tasks ("Run chain"). Parent owns creation. */
  onRunChain: (chainId: string) => void;
}) {
  const [activeChainId, setActiveChainId] = useState<string | null>(
    config.chains && config.chains.length ? config.chains[0].id : null,
  );

  // task-e713f307c422 — approved SavedQueries a field can bind as its data
  // source (typeahead). Fetched once on mount; [] when signed out.
  const [approvedQueries, setApprovedQueries] = useState<SavedQuerySummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listApprovedQueries()
      .then((qs) => {
        if (!cancelled) setApprovedQueries(qs);
      })
      .catch(() => {
        /* signed out / offline — leave the picker empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chains = config.chains ?? [];
  const taskDefs = config.taskDefs ?? [];
  // Keep the selected chain valid as chains are added/removed out from under us
  // (e.g. by a copilot action). Fall back to the first chain, or null.
  const activeChain =
    chains.find((c) => c.id === activeChainId) ?? (chains.length ? chains[0] : null);
  useEffect(() => {
    if (activeChain && activeChain.id !== activeChainId) setActiveChainId(activeChain.id);
    if (!activeChain && activeChainId !== null) setActiveChainId(null);
  }, [activeChain, activeChainId]);

  // Escape closes the panel, matching the other New Home overlays' convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Demo statuses for the chain preview strip — this editor has no live task
  // data, so it fabricates a plausible progression purely to exercise
  // ChainStrip's states. Real per-task statuses get wired by the integration
  // task that adopts ChainStrip in the roster/dialog.
  const chainPreviewSteps: ChainStripStep[] = useMemo(() => {
    if (!activeChain) return [];
    const reps = config.repeatables ?? [];
    return activeChain.entries.map((entry, i) => {
      let status: ChainStripStep['status'] = 'pending';
      if (i === 0) status = 'done';
      else if (i === 1) status = 'progress';
      if (entry.humanGate && i > 1) status = 'needs';
      const rep = entry.repeatableId ? reps.find((r) => r.id === entry.repeatableId) : undefined;
      const name = rep
        ? rep.title
        : entry.titleTemplate
            .replace(/\{\{\s*n\s*\}\}/gi, String(i + 1))
            .replace(/\{\{\s*chain\s*\}\}/gi, activeChain.name) || `Step ${i + 1}`;
      return { id: entry.id, name, status, humanGate: !!entry.humanGate };
    });
  }, [activeChain, config.repeatables]);

  function addChainAndSelect() {
    const { cfg, chainId } = ops.addChain(config);
    onChange(cfg);
    setActiveChainId(chainId);
  }

  // ─── Tasks tab (task-af3a8fdc8974) render helpers ───────────────────────
  // All mutations route through the shared ops in newHomeTemplateOps.ts — this
  // panel never reimplements the state logic those ops already own.

  /** One editable input/output field row inside a task-def. `kind` decides
   *  whether the "required (evidence)" toggle shows (outputs only). */
  function renderTaskDefField(
    taskDef: TaskDef,
    kind: 'inputs' | 'outputs',
    field: TaskDefField,
    i: number,
    count: number,
  ) {
    const keyValid = KEY_PATTERN.test(field.key);
    return (
      <div className="nh-te__row nh-te__field-row" key={kind + ':' + field.key}>
        <div className="nh-te__step-order">
          <button
            type="button"
            className="nh-te__icon-btn"
            onClick={() => onChange(ops.moveTaskDefField(config, taskDef.id, kind, field.key, -1))}
            disabled={i === 0}
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="nh-te__icon-btn"
            onClick={() => onChange(ops.moveTaskDefField(config, taskDef.id, kind, field.key, 1))}
            disabled={i === count - 1}
            title="Move down"
          >
            ↓
          </button>
        </div>
        <input
          className="nh-te__input"
          placeholder="Label"
          value={field.label}
          onChange={(e) =>
            onChange(ops.updateTaskDefField(config, taskDef.id, kind, field.key, { label: e.target.value }))
          }
        />
        <input
          className={'nh-te__input nh-te__input--key' + (keyValid ? '' : ' nh-te__input--invalid')}
          placeholder="key"
          value={field.key}
          title={keyValid ? 'Field key' : 'Key must match [a-z0-9._-]+'}
          onChange={(e) =>
            onChange(
              ops.updateTaskDefField(config, taskDef.id, kind, field.key, {
                key: sanitizeKey(e.target.value),
              }),
            )
          }
        />
        <select
          className="nh-te__select"
          value={field.type}
          onChange={(e) =>
            onChange(
              ops.updateTaskDefField(config, taskDef.id, kind, field.key, {
                type: e.target.value as TaskDefField['type'],
              }),
            )
          }
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="date">date</option>
          <option value="select">select</option>
          <option value="bool">bool</option>
        </select>
        {field.type === 'select' && (
          <input
            className="nh-te__input"
            placeholder="options, comma-separated"
            value={(field.options ?? []).join(', ')}
            onChange={(e) =>
              onChange(
                ops.updateTaskDefField(config, taskDef.id, kind, field.key, {
                  options: e.target.value
                    .split(',')
                    .map((o) => o.trim())
                    .filter(Boolean),
                }),
              )
            }
          />
        )}
        {kind === 'outputs' && (
          <label
            className="nh-te__checkbox"
            title="Required output = the task's evidence of completion"
          >
            <input
              type="checkbox"
              checked={!!field.required}
              onChange={(e) =>
                onChange(
                  ops.updateTaskDefField(config, taskDef.id, kind, field.key, {
                    required: e.target.checked,
                  }),
                )
              }
            />
            required (evidence)
          </label>
        )}
        <button
          type="button"
          className="nh-te__icon-btn"
          onClick={() => onChange(ops.removeTaskDefField(config, taskDef.id, kind, field.key))}
          title="Remove field"
        >
          ✕
        </button>
      </div>
    );
  }

  /** The neededWhen condition picker for one task-def. Upstream = any task-def
   *  strictly EARLIER in the chain (`upstream`); an empty selection means
   *  "always needed" (neededWhen cleared to null). */
  function renderNeededWhen(taskDef: TaskDef, upstream: TaskDef[]) {
    const cond = taskDef.neededWhen ?? null;
    const parsed = cond ? splitRef(cond.ref) : null;
    // The upstream def the current condition points at (if still valid).
    const selectedDef = parsed ? upstream.find((d) => d.id === parsed.taskDefId) : undefined;

    if (upstream.length === 0) {
      return (
        <p className="nh-te__hint nh-te__needed-note">
          Always needed — the first task-def in the chain has no upstream output to gate on.
        </p>
      );
    }

    function setCond(next: Partial<{ taskDefId: string; key: string; op: TaskDefCondition['op']; value: string }>) {
      const curTaskDefId = next.taskDefId ?? parsed?.taskDefId ?? '';
      const curKey = next.key ?? parsed?.key ?? '';
      const curOp = next.op ?? cond?.op ?? '==';
      const curValue = next.value ?? (cond ? String(cond.value) : '');
      if (!curTaskDefId) {
        // No upstream selected → "always needed".
        onChange(ops.setTaskDefNeededWhen(config, taskDef.id, null));
        return;
      }
      onChange(
        ops.setTaskDefNeededWhen(config, taskDef.id, {
          ref: `${curTaskDefId}.${curKey}`,
          op: curOp,
          value: curValue,
        }),
      );
    }

    return (
      <div className="nh-te__needed">
        <span className="nh-te__subhead">Needed when</span>
        <select
          className="nh-te__select"
          value={parsed?.taskDefId ?? ''}
          title="Upstream task-def whose output gates this step"
          onChange={(e) => {
            const id = e.target.value;
            if (!id) {
              onChange(ops.setTaskDefNeededWhen(config, taskDef.id, null));
              return;
            }
            const def = upstream.find((d) => d.id === id);
            const firstKey = def?.outputs[0]?.key ?? '';
            setCond({ taskDefId: id, key: firstKey });
          }}
        >
          <option value="">Always needed</option>
          {upstream.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name || 'Untitled step'}
            </option>
          ))}
        </select>
        {selectedDef && (
          <>
            <select
              className="nh-te__select"
              value={parsed?.key ?? ''}
              title="Which output of the upstream task-def to compare"
              onChange={(e) => setCond({ key: e.target.value })}
            >
              {selectedDef.outputs.length === 0 && <option value="">(no outputs)</option>}
              {selectedDef.outputs.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label || o.key}
                </option>
              ))}
            </select>
            <select
              className="nh-te__select nh-te__select--op"
              value={cond?.op ?? '=='}
              title="Comparison"
              onChange={(e) => setCond({ op: e.target.value as TaskDefCondition['op'] })}
            >
              {COND_OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <input
              className="nh-te__input"
              placeholder="value"
              value={cond ? String(cond.value) : ''}
              onChange={(e) => setCond({ value: e.target.value })}
            />
            <button
              type="button"
              className="nh-te__icon-btn"
              onClick={() => onChange(ops.setTaskDefNeededWhen(config, taskDef.id, null))}
              title="Clear condition (always needed)"
            >
              ✕
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="nh-te nh-te--inline" aria-label="Customize template">
      <div className="nh-te__head">
        <div className="nh-te__head-title">
          Customize {projectId ? 'project' : 'default'} template
        </div>
        <button type="button" className="nh-te__done" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="nh-te__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={'nh-te__tab' + (tab === t.id ? ' nh-te__tab--active' : '')}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="nh-te__body">
        {tab === 'tasks' && (
          <div className="nh-te__section">
            <p className="nh-te__hint">
              A template is an ordered chain of task-defs. Each task-def owns its own inputs (the
              human supplies at creation) and outputs (the agent produces; required outputs are the
              step&apos;s evidence). The new-task form and roster columns are built by aggregating
              every task-def&apos;s fields.
            </p>
            {taskDefs.length === 0 && (
              <p className="nh-te__empty">No task-defs yet — add one to start the chain.</p>
            )}
            {taskDefs.map((taskDef, i) => {
              const upstream = taskDefs.slice(0, i);
              return (
                <div className="nh-te__taskdef" key={taskDef.id}>
                  <div className="nh-te__row nh-te__taskdef-head">
                    <div className="nh-te__step-order">
                      <button
                        type="button"
                        className="nh-te__icon-btn"
                        onClick={() => onChange(ops.moveTaskDef(config, taskDef.id, -1))}
                        disabled={i === 0}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="nh-te__icon-btn"
                        onClick={() => onChange(ops.moveTaskDef(config, taskDef.id, 1))}
                        disabled={i === taskDefs.length - 1}
                        title="Move down"
                      >
                        ↓
                      </button>
                    </div>
                    <span className="nh-te__taskdef-num">{i + 1}</span>
                    <input
                      className="nh-te__input nh-te__input--wide"
                      placeholder="Task-def name"
                      value={taskDef.name}
                      onChange={(e) => onChange(ops.updateTaskDef(config, taskDef.id, { name: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="nh-te__icon-btn"
                      onClick={() => onChange(ops.removeTaskDef(config, taskDef.id))}
                      title="Remove task-def"
                    >
                      ✕
                    </button>
                  </div>

                  <textarea
                    className="nh-te__input nh-te__textarea"
                    placeholder="Notes — base agent prompt for this step (optional)"
                    value={taskDef.notes ?? ''}
                    onChange={(e) => onChange(ops.updateTaskDef(config, taskDef.id, { notes: e.target.value }))}
                  />

                  {renderNeededWhen(taskDef, upstream)}

                  <div className="nh-te__taskdef-fields">
                    <span className="nh-te__subhead">Inputs</span>
                    {taskDef.inputs.length === 0 && (
                      <p className="nh-te__empty">No input fields.</p>
                    )}
                    {taskDef.inputs.map((f, fi) =>
                      renderTaskDefField(taskDef, 'inputs', f, fi, taskDef.inputs.length),
                    )}
                    <button
                      type="button"
                      className="nh-te__add-btn"
                      onClick={() =>
                        onChange(ops.addTaskDefField(config, taskDef.id, 'inputs', { label: 'New input' }).cfg)
                      }
                    >
                      + Add input
                    </button>
                  </div>

                  <div className="nh-te__taskdef-fields">
                    <span className="nh-te__subhead">Outputs</span>
                    {taskDef.outputs.length === 0 && (
                      <p className="nh-te__empty">No output fields.</p>
                    )}
                    {taskDef.outputs.map((f, fi) =>
                      renderTaskDefField(taskDef, 'outputs', f, fi, taskDef.outputs.length),
                    )}
                    <button
                      type="button"
                      className="nh-te__add-btn"
                      onClick={() =>
                        onChange(ops.addTaskDefField(config, taskDef.id, 'outputs', { label: 'New output' }).cfg)
                      }
                    >
                      + Add output
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              className="nh-te__add-btn"
              onClick={() => onChange(ops.addTaskDef(config).cfg)}
            >
              + Add task-def
            </button>
          </div>
        )}

        {tab === 'fields' && (
          <div className="nh-te__section">
            {config.fields.length === 0 && <p className="nh-te__empty">No custom fields yet.</p>}
            {config.fields.map((field) => (
              <div className="nh-te__row nh-te__field-row" key={field.key}>
                <input
                  className="nh-te__input"
                  placeholder="Label"
                  value={field.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    onChange(
                      ops.updateField(config, field.key, {
                        label,
                        key: field.key.startsWith('field-') ? ops.slugify(label) : field.key,
                      }),
                    );
                  }}
                />
                <input
                  className="nh-te__input nh-te__input--key"
                  placeholder="key"
                  value={field.key}
                  onChange={(e) => onChange(ops.updateField(config, field.key, { key: e.target.value }))}
                />
                <select
                  className="nh-te__select"
                  value={field.type}
                  onChange={(e) =>
                    onChange(ops.updateField(config, field.key, { type: e.target.value as TemplateField['type'] }))
                  }
                >
                  <option value="text">text</option>
                  <option value="date">date</option>
                  <option value="select">select</option>
                  <option value="number">number</option>
                </select>
                {field.type === 'select' && (
                  <input
                    className="nh-te__input"
                    placeholder="options, comma-separated"
                    value={(field.options ?? []).join(', ')}
                    onChange={(e) =>
                      onChange(
                        ops.updateField(config, field.key, {
                          options: e.target.value
                            .split(',')
                            .map((o) => o.trim())
                            .filter(Boolean),
                        }),
                      )
                    }
                  />
                )}
                <label className="nh-te__checkbox">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(e) => onChange(ops.updateField(config, field.key, { required: e.target.checked }))}
                  />
                  required
                </label>
                <label className="nh-te__checkbox">
                  <input
                    type="checkbox"
                    checked={field.agentFetchable}
                    onChange={(e) =>
                      onChange(ops.updateField(config, field.key, { agentFetchable: e.target.checked }))
                    }
                  />
                  agent-fetchable
                </label>
                {/* task-e713f307c422 — bind an approved SavedQuery so this field
                    becomes a live typeahead in New Task. Empty = plain field. */}
                <label className="nh-te__checkbox nh-te__source" title="Back this field with a live data source (typeahead)">
                  <span className="nh-te__source-label">source</span>
                  <select
                    className="nh-te__select"
                    value={field.source?.savedQueryId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) {
                        onChange(ops.updateField(config, field.key, { source: undefined }));
                        return;
                      }
                      const q = approvedQueries.find((sq) => sq.id === id);
                      onChange(
                        ops.updateField(config, field.key, {
                          source: { savedQueryId: id, version: q?.version, entityType: q?.entityType },
                        }),
                      );
                    }}
                  >
                    <option value="">none</option>
                    {field.source?.savedQueryId &&
                      !approvedQueries.some((q) => q.id === field.source!.savedQueryId) && (
                        <option value={field.source.savedQueryId}>
                          {field.source.savedQueryId} (unavailable)
                        </option>
                      )}
                    {approvedQueries.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name} v{q.version}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="nh-te__icon-btn"
                  onClick={() => onChange(ops.removeField(config, field.key))}
                  title="Remove field"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="nh-te__add-btn"
              onClick={() =>
                onChange(
                  ops.addField(config, {
                    key: ops.uid('field'),
                    label: 'New field',
                    type: 'text',
                    required: false,
                    agentFetchable: false,
                  }),
                )
              }
            >
              + Add field
            </button>
          </div>
        )}

        {tab === 'columns' && (
          <div className="nh-te__section">
            <p className="nh-te__hint">Choose which columns show in the roster table, and their order.</p>
            {config.columns.map((colId, i) => {
              const builtin = BUILTIN_COLUMNS.find((b) => b.id === colId);
              const field = config.fields.find((f) => f.key === colId);
              const label = builtin?.label ?? field?.label ?? colId;
              return (
                <div className="nh-te__row" key={colId + i}>
                  <span className="nh-te__col-label">{label}</span>
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.moveColumn(config, i, -1))}
                    disabled={i === 0}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.moveColumn(config, i, 1))}
                    disabled={i === config.columns.length - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.toggleColumn(config, colId, false))}
                    title="Remove column"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <p className="nh-te__hint">Add a column:</p>
            <div className="nh-te__chip-row">
              {[...BUILTIN_COLUMNS.map((b) => ({ id: b.id, label: b.label })), ...config.fields.map((f) => ({ id: f.key, label: f.label }))]
                .filter((c) => !config.columns.includes(c.id))
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="nh-te__chip"
                    onClick={() => onChange(ops.toggleColumn(config, c.id, true))}
                  >
                    + {c.label}
                  </button>
                ))}
            </div>
          </div>
        )}

        {tab === 'approvals' && (
          <div className="nh-te__section">
            {config.approvalRules.length === 0 && <p className="nh-te__empty">No approval rules yet.</p>}
            {config.approvalRules.map((rule) => (
              <div className="nh-te__row" key={rule.id}>
                <input
                  className="nh-te__input nh-te__input--wide"
                  placeholder='e.g. "always ask before submitting over $1,000"'
                  value={rule.description}
                  onChange={(e) => onChange(ops.updateApprovalRule(config, rule.id, e.target.value))}
                />
                <button
                  type="button"
                  className="nh-te__icon-btn"
                  onClick={() => onChange(ops.removeApprovalRule(config, rule.id))}
                  title="Remove rule"
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="nh-te__add-btn" onClick={() => onChange(ops.addApprovalRule(config))}>
              + Add rule
            </button>
          </div>
        )}

        {tab === 'steps' && (
          <div className="nh-te__section">
            <p className="nh-te__legacy">
              <span className="nh-te__badge nh-te__badge--legacy">Legacy</span>
              Superseded by the Tasks tab — a step is now a task-def. Kept for existing templates.
            </p>
            {config.steps.length === 0 && <p className="nh-te__empty">No steps yet.</p>}
            {config.steps.map((step, i) => (
              <div className="nh-te__row nh-te__step-row" key={step.id}>
                <div className="nh-te__step-order">
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.moveStep(config, step.id, -1))}
                    disabled={i === 0}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.moveStep(config, step.id, 1))}
                    disabled={i === config.steps.length - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                </div>
                <input
                  className="nh-te__input"
                  placeholder="Step name"
                  value={step.name}
                  onChange={(e) => onChange(ops.updateStep(config, step.id, { name: e.target.value }))}
                />
                <input
                  className="nh-te__input nh-te__input--wide"
                  placeholder="Description"
                  value={step.description}
                  onChange={(e) => onChange(ops.updateStep(config, step.id, { description: e.target.value }))}
                />
                <button
                  type="button"
                  className={'nh-te__gate-btn' + (step.humanGate ? ' nh-te__gate-btn--on' : '')}
                  onClick={() => onChange(ops.updateStep(config, step.id, { humanGate: !step.humanGate }))}
                  title={step.humanGate ? 'Human approval required — click to make automatic' : 'Automatic — click to require human approval'}
                >
                  {step.humanGate ? '🔒 human gate' : '🔓 automatic'}
                </button>
                <button
                  type="button"
                  className="nh-te__icon-btn"
                  onClick={() => onChange(ops.removeStep(config, step.id))}
                  title="Remove step"
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="nh-te__add-btn" onClick={() => onChange(ops.addStep(config))}>
              + Add step
            </button>
          </div>
        )}

        {tab === 'chains' && (
          <div className="nh-te__section nh-te__chains">
            <p className="nh-te__legacy">
              <span className="nh-te__badge nh-te__badge--legacy">Legacy</span>
              Superseded by the Tasks tab — task-defs are the ordered chain now. Kept for existing
              templates.
            </p>
            <div className="nh-te__chain-list">
              {chains.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={'nh-te__chain-tab' + (c.id === activeChain?.id ? ' nh-te__chain-tab--active' : '')}
                  onClick={() => setActiveChainId(c.id)}
                >
                  {c.name || 'Untitled chain'}
                </button>
              ))}
              <button type="button" className="nh-te__add-btn" onClick={addChainAndSelect}>
                + Add chain
              </button>
            </div>

            {activeChain ? (
              <div className="nh-te__chain-detail">
                <div className="nh-te__row">
                  <input
                    className="nh-te__input nh-te__input--wide"
                    placeholder="Chain name"
                    value={activeChain.name}
                    onChange={(e) => onChange(ops.renameChain(config, activeChain.id, e.target.value))}
                  />
                  <button
                    type="button"
                    className="nh-te__run-btn"
                    onClick={() => onRunChain(activeChain.id)}
                    disabled={activeChain.entries.length === 0}
                    title="Create linked tasks for every step in this chain"
                  >
                    ▶ Run chain
                  </button>
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.removeChain(config, activeChain.id))}
                    title="Remove chain"
                  >
                    ✕
                  </button>
                </div>

                {activeChain.entries.length === 0 && (
                  <p className="nh-te__empty">
                    No tasks in this chain yet — add a repeatable task from the dropdown below, or a
                    free-form step.
                  </p>
                )}
                {activeChain.entries.map((entry, i) => {
                  const rep = entry.repeatableId
                    ? (config.repeatables ?? []).find((r) => r.id === entry.repeatableId)
                    : undefined;
                  return (
                    <div className="nh-te__row" key={entry.id}>
                      <div className="nh-te__step-order">
                        <button
                          type="button"
                          className="nh-te__icon-btn"
                          onClick={() => onChange(ops.moveChainEntry(config, activeChain.id, entry.id, -1))}
                          disabled={i === 0}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="nh-te__icon-btn"
                          onClick={() => onChange(ops.moveChainEntry(config, activeChain.id, entry.id, 1))}
                          disabled={i === activeChain.entries.length - 1}
                          title="Move down"
                        >
                          ↓
                        </button>
                      </div>
                      {entry.repeatableId ? (
                        <span className="nh-te__chain-task">
                          <span className="nh-te__badge">task</span>
                          {rep ? rep.title : entry.titleTemplate || '(deleted repeatable task)'}
                        </span>
                      ) : (
                        <input
                          className="nh-te__input nh-te__input--wide"
                          placeholder="Title template, e.g. Draft outreach #{{n}}"
                          value={entry.titleTemplate}
                          onChange={(e) => onChange(ops.updateChainEntry(config, activeChain.id, entry.id, { titleTemplate: e.target.value }))}
                        />
                      )}
                      <button
                        type="button"
                        className={'nh-te__gate-btn' + (entry.humanGate ? ' nh-te__gate-btn--on' : '')}
                        onClick={() => onChange(ops.updateChainEntry(config, activeChain.id, entry.id, { humanGate: !entry.humanGate }))}
                        title="Toggle human gate"
                      >
                        {entry.humanGate ? '🔒' : '🔓'}
                      </button>
                      <button
                        type="button"
                        className="nh-te__icon-btn"
                        onClick={() => onChange(ops.removeChainEntry(config, activeChain.id, entry.id))}
                        title="Remove step"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}

                <div className="nh-te__row nh-te__chain-add">
                  {/* Pick an existing Repeatable Task to append as a chain step. */}
                  <select
                    className="nh-te__select"
                    value=""
                    onChange={(e) => {
                      const rep = (config.repeatables ?? []).find((r) => r.id === e.target.value);
                      if (rep) {
                        onChange(
                          ops.addChainEntry(config, activeChain.id, {
                            repeatableId: rep.id,
                            titleTemplate: rep.title,
                          }),
                        );
                      }
                      e.target.value = '';
                    }}
                  >
                    <option value="">+ Add task…</option>
                    {(config.repeatables ?? []).length === 0 && (
                      <option value="" disabled>
                        (no repeatable tasks — add some on the Repeatable Tasks tab)
                      </option>
                    )}
                    {(config.repeatables ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="nh-te__add-btn"
                    onClick={() => onChange(ops.addChainEntry(config, activeChain.id))}
                  >
                    + Free-form step
                  </button>
                </div>

                <div className="nh-te__chain-preview">
                  <p className="nh-te__hint">Preview (statuses are illustrative — no live task data here):</p>
                  <ChainStrip steps={chainPreviewSteps} />
                </div>
              </div>
            ) : (
              <p className="nh-te__empty">No chains yet — add one to define a reusable task sequence.</p>
            )}
          </div>
        )}

        {tab === 'repeatable' && (
          <div className="nh-te__section">
            <p className="nh-te__legacy">
              <span className="nh-te__badge nh-te__badge--legacy">Legacy</span>
              Superseded by the Tasks tab — a repeatable ≈ a single task-def. Kept for existing
              templates.
            </p>
            <p className="nh-te__hint">
              Repeatable tasks are templates you can spawn on demand (<em>Run now</em>) or on a
              schedule. A scheduled task repeats after each completion (the server spawns the next
              occurrence).
            </p>
            {(config.repeatables ?? []).length === 0 && (
              <p className="nh-te__empty">No repeatable tasks yet.</p>
            )}
            {(config.repeatables ?? []).map((rep, i) => (
              <div className="nh-te__row nh-te__field-row nh-te__rep-row" key={rep.id}>
                <div className="nh-te__step-order">
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.moveRepeatable(config, rep.id, -1))}
                    disabled={i === 0}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.moveRepeatable(config, rep.id, 1))}
                    disabled={i === (config.repeatables ?? []).length - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                </div>
                <input
                  className="nh-te__input nh-te__input--wide"
                  placeholder="Task title"
                  value={rep.title}
                  onChange={(e) => onChange(ops.updateRepeatable(config, rep.id, { title: e.target.value }))}
                />
                <input
                  className="nh-te__input nh-te__input--wide"
                  placeholder="Notes (optional)"
                  value={rep.notes ?? ''}
                  onChange={(e) => onChange(ops.updateRepeatable(config, rep.id, { notes: e.target.value }))}
                />
                <select
                  className="nh-te__select"
                  value={rep.recurrence ?? ''}
                  title="Schedule"
                  onChange={(e) => onChange(ops.updateRepeatable(config, rep.id, { recurrence: e.target.value }))}
                >
                  {ops.SCHEDULE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="nh-te__run-btn"
                  onClick={() => onRunRepeatable(rep.id)}
                  disabled={!rep.title.trim()}
                  title={rep.recurrence ? 'Create this task now; it will repeat on schedule' : 'Create this task now'}
                >
                  ▶ Run now
                </button>
                <button
                  type="button"
                  className="nh-te__icon-btn"
                  onClick={() => onChange(ops.removeRepeatable(config, rep.id))}
                  title="Remove repeatable task"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="nh-te__add-btn"
              onClick={() => onChange(ops.addRepeatable(config).cfg)}
            >
              + Add repeatable task
            </button>
          </div>
        )}

        {tab === 'preview' && (
          <div className="nh-te__section">
            <p className="nh-te__hint">This is what the new-task form will ask for, from the current fields:</p>
            <div className="nh-te__form-preview">
              <div className="nh-te__form-row nh-te__form-row--builtin">
                <span className="nh-te__form-label">Title</span>
                <span className="nh-te__form-control nh-te__form-control--placeholder">Task title…</span>
              </div>
              {config.fields.length === 0 && (
                <p className="nh-te__empty">No custom fields — the form only asks for a title.</p>
              )}
              {config.fields.map((field) => (
                <div className="nh-te__form-row" key={field.key}>
                  <span className="nh-te__form-label">
                    {field.label}
                    {field.required && <span className="nh-te__required">*</span>}
                    {field.agentFetchable && (
                      <span className="nh-te__badge" title="Agent can fetch this value">
                        agent
                      </span>
                    )}
                  </span>
                  {field.type === 'select' ? (
                    <span className="nh-te__form-control nh-te__form-control--placeholder">
                      {(field.options ?? []).join(' / ') || 'Choose…'}
                    </span>
                  ) : (
                    <span className="nh-te__form-control nh-te__form-control--placeholder">
                      {field.type === 'date' ? 'YYYY-MM-DD' : field.type === 'number' ? '0' : '…'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
