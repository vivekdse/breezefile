// task-c60ae2a41e71 — full TemplateEditor: field/column/approval-rule/step/
// chain editor + a read-only form preview, replacing the earlier round-trip
// stub. Reuses the .nh-modal-* shell vocabulary already established by
// NewTaskModal/TaskDetailDialog so every New Home overlay reads as one
// system.
//
// Ownership: this file, TemplateEditor.css, newHomePrefs.ts, and
// ChainStrip.tsx/.css. Do not import from types.ts changes beyond what's
// already there — chains are carried via the local `TemplateConfigExt`
// extension defined in newHomePrefs.ts, not by widening the shared
// `TemplateConfig` (owned elsewhere).
import { useMemo, useState } from 'react';
import type { TemplateConfig, TemplateField } from './types';
import type { ChainDef, ChainStepTemplate } from './newHomePrefs';
import { getTemplateConfig } from './newHomePrefs';
import { ChainStrip, type ChainStripStep } from './ChainStrip';
import './TemplateEditor.css';

type TemplateConfigExt = TemplateConfig & { chains?: ChainDef[] };

type Tab = 'fields' | 'columns' | 'approvals' | 'steps' | 'chains' | 'preview';

const TABS: { id: Tab; label: string }[] = [
  { id: 'fields', label: 'Fields' },
  { id: 'columns', label: 'Columns' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'steps', label: 'Steps' },
  { id: 'chains', label: 'Chains' },
  { id: 'preview', label: 'Preview' },
];

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}-${rand}`;
}

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field';
}

const BUILTIN_COLUMNS = [
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'who', label: 'Who' },
  { id: 'lastAction', label: 'Last action' },
  { id: 'risk', label: 'Risk' },
];

function moveItem<T>(arr: T[], index: number, dir: -1 | 1): T[] {
  const next = arr.slice();
  const target = index + dir;
  if (target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function TemplateEditor({
  projectId,
  config,
  onSave,
  onClose,
}: {
  projectId: string;
  config: TemplateConfig;
  onSave: (cfg: TemplateConfig) => void;
  onClose: () => void;
}) {
  // `config` comes from newHomePrefs.getTemplateConfig(), which already
  // returns the extended shape (chains riding as an extra, optional field);
  // re-read defensively in case a caller ever passes a plain TemplateConfig
  // (e.g. a freshly-created project with no stored chains yet).
  const initial = useMemo<TemplateConfigExt>(() => {
    const ext = config as TemplateConfigExt;
    return {
      fields: ext.fields ?? [],
      columns: ext.columns ?? [],
      approvalRules: ext.approvalRules ?? [],
      steps: ext.steps ?? [],
      chains: ext.chains ?? getTemplateConfig(projectId || null).chains ?? [],
    };
  }, [config, projectId]);

  const [tab, setTab] = useState<Tab>('fields');
  const [draft, setDraft] = useState<TemplateConfigExt>(initial);
  const [activeChainId, setActiveChainId] = useState<string | null>(
    initial.chains && initial.chains.length ? initial.chains[0].id : null,
  );

  function updateField(index: number, patch: Partial<TemplateField>) {
    setDraft((d) => {
      const fields = d.fields.slice();
      fields[index] = { ...fields[index], ...patch };
      return { ...d, fields };
    });
  }

  function addField() {
    const field: TemplateField = {
      key: uid('field'),
      label: 'New field',
      type: 'text',
      required: false,
      agentFetchable: false,
    };
    setDraft((d) => ({ ...d, fields: [...d.fields, field] }));
  }

  function removeField(index: number) {
    setDraft((d) => {
      const removed = d.fields[index];
      return {
        ...d,
        fields: d.fields.filter((_, i) => i !== index),
        columns: d.columns.filter((c) => c !== removed.key),
      };
    });
  }

  function toggleColumn(id: string, on: boolean) {
    setDraft((d) => ({
      ...d,
      columns: on ? [...d.columns, id] : d.columns.filter((c) => c !== id),
    }));
  }

  function moveColumn(index: number, dir: -1 | 1) {
    setDraft((d) => ({ ...d, columns: moveItem(d.columns, index, dir) }));
  }

  function addApprovalRule() {
    setDraft((d) => ({
      ...d,
      approvalRules: [...d.approvalRules, { id: uid('rule'), description: '' }],
    }));
  }
  function updateApprovalRule(index: number, description: string) {
    setDraft((d) => {
      const approvalRules = d.approvalRules.slice();
      approvalRules[index] = { ...approvalRules[index], description };
      return { ...d, approvalRules };
    });
  }
  function removeApprovalRule(index: number) {
    setDraft((d) => ({ ...d, approvalRules: d.approvalRules.filter((_, i) => i !== index) }));
  }

  function addStep() {
    setDraft((d) => ({
      ...d,
      steps: [...d.steps, { id: uid('step'), name: 'New step', description: '', humanGate: false }],
    }));
  }
  function updateStep(index: number, patch: Partial<TemplateConfig['steps'][number]>) {
    setDraft((d) => {
      const steps = d.steps.slice();
      steps[index] = { ...steps[index], ...patch };
      return { ...d, steps };
    });
  }
  function removeStep(index: number) {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }));
  }
  function moveStep(index: number, dir: -1 | 1) {
    setDraft((d) => ({ ...d, steps: moveItem(d.steps, index, dir) }));
  }

  const chains = draft.chains ?? [];
  const activeChain = chains.find((c) => c.id === activeChainId) ?? null;

  function updateChains(next: ChainDef[]) {
    setDraft((d) => ({ ...d, chains: next }));
  }

  function addChain() {
    const chain: ChainDef = { id: uid('chain'), name: 'New chain', entries: [] };
    updateChains([...chains, chain]);
    setActiveChainId(chain.id);
  }

  function removeChain(id: string) {
    const next = chains.filter((c) => c.id !== id);
    updateChains(next);
    if (activeChainId === id) setActiveChainId(next.length ? next[0].id : null);
  }

  function renameChain(id: string, name: string) {
    updateChains(chains.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  function addChainEntry(chainId: string) {
    const entry: ChainStepTemplate = { id: uid('entry'), titleTemplate: 'Step {{n}} of {{chain}}' };
    updateChains(
      chains.map((c) => (c.id === chainId ? { ...c, entries: [...c.entries, entry] } : c)),
    );
  }

  function updateChainEntry(chainId: string, index: number, patch: Partial<ChainStepTemplate>) {
    updateChains(
      chains.map((c) => {
        if (c.id !== chainId) return c;
        const entries = c.entries.slice();
        entries[index] = { ...entries[index], ...patch };
        return { ...c, entries };
      }),
    );
  }

  function removeChainEntry(chainId: string, index: number) {
    updateChains(
      chains.map((c) =>
        c.id === chainId ? { ...c, entries: c.entries.filter((_, i) => i !== index) } : c,
      ),
    );
  }

  function moveChainEntry(chainId: string, index: number, dir: -1 | 1) {
    updateChains(
      chains.map((c) => (c.id === chainId ? { ...c, entries: moveItem(c.entries, index, dir) } : c)),
    );
  }

  // Demo statuses for the chain preview strip — this editor has no live task
  // data to reflect, so it fabricates a plausible progression (first done,
  // second in progress, rest pending; a gated entry shows as "needs" unless
  // it's already past) purely to exercise ChainStrip's states. The real
  // per-task statuses get wired by the integration task that adopts
  // ChainStrip in the roster/dialog.
  const chainPreviewSteps: ChainStripStep[] = useMemo(() => {
    if (!activeChain) return [];
    return activeChain.entries.map((entry, i) => {
      let status: ChainStripStep['status'] = 'pending';
      if (i === 0) status = 'done';
      else if (i === 1) status = 'progress';
      if (entry.humanGate && i > 1) status = 'needs';
      return {
        id: entry.id,
        name:
          entry.titleTemplate
            .replace(/\{\{\s*n\s*\}\}/gi, String(i + 1))
            .replace(/\{\{\s*chain\s*\}\}/gi, activeChain.name) || `Step ${i + 1}`,
        status,
        humanGate: !!entry.humanGate,
      };
    });
  }, [activeChain]);

  return (
    <div className="nh-modal-overlay" onClick={onClose}>
      <div className="nh-template-editor" onClick={(e) => e.stopPropagation()}>
        <div className="nh-modal__head">
          <div className="nh-modal__title">
            Customize {projectId ? 'project' : 'default'} template
          </div>
          <button type="button" className="nh-modal__close" onClick={onClose}>
            ×
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
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="nh-modal__body nh-te__body">
          {tab === 'fields' && (
            <div className="nh-te__section">
              {draft.fields.length === 0 && (
                <p className="nh-te__empty">No custom fields yet.</p>
              )}
              {draft.fields.map((field, i) => (
                <div className="nh-te__row nh-te__field-row" key={field.key || i}>
                  <input
                    className="nh-te__input"
                    placeholder="Label"
                    value={field.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      updateField(i, {
                        label,
                        key: field.key.startsWith('field-') ? slugify(label) : field.key,
                      });
                    }}
                  />
                  <input
                    className="nh-te__input nh-te__input--key"
                    placeholder="key"
                    value={field.key}
                    onChange={(e) => updateField(i, { key: e.target.value })}
                  />
                  <select
                    className="nh-te__select"
                    value={field.type}
                    onChange={(e) => updateField(i, { type: e.target.value as TemplateField['type'] })}
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
                        updateField(i, {
                          options: e.target.value
                            .split(',')
                            .map((o) => o.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  )}
                  <label className="nh-te__checkbox">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => updateField(i, { required: e.target.checked })}
                    />
                    required
                  </label>
                  <label className="nh-te__checkbox">
                    <input
                      type="checkbox"
                      checked={field.agentFetchable}
                      onChange={(e) => updateField(i, { agentFetchable: e.target.checked })}
                    />
                    agent-fetchable
                  </label>
                  <button type="button" className="nh-te__icon-btn" onClick={() => removeField(i)} title="Remove field">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="nh-te__add-btn" onClick={addField}>
                + Add field
              </button>
            </div>
          )}

          {tab === 'columns' && (
            <div className="nh-te__section">
              <p className="nh-te__hint">Choose which columns show in the roster table, and their order.</p>
              {draft.columns.map((colId, i) => {
                const builtin = BUILTIN_COLUMNS.find((b) => b.id === colId);
                const field = draft.fields.find((f) => f.key === colId);
                const label = builtin?.label ?? field?.label ?? colId;
                return (
                  <div className="nh-te__row" key={colId + i}>
                    <span className="nh-te__col-label">{label}</span>
                    <button type="button" className="nh-te__icon-btn" onClick={() => moveColumn(i, -1)} disabled={i === 0} title="Move up">
                      ↑
                    </button>
                    <button
                      type="button"
                      className="nh-te__icon-btn"
                      onClick={() => moveColumn(i, 1)}
                      disabled={i === draft.columns.length - 1}
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button type="button" className="nh-te__icon-btn" onClick={() => toggleColumn(colId, false)} title="Remove column">
                      ✕
                    </button>
                  </div>
                );
              })}
              <p className="nh-te__hint">Add a column:</p>
              <div className="nh-te__chip-row">
                {[...BUILTIN_COLUMNS.map((b) => ({ id: b.id, label: b.label })), ...draft.fields.map((f) => ({ id: f.key, label: f.label }))]
                  .filter((c) => !draft.columns.includes(c.id))
                  .map((c) => (
                    <button key={c.id} type="button" className="nh-te__chip" onClick={() => toggleColumn(c.id, true)}>
                      + {c.label}
                    </button>
                  ))}
              </div>
            </div>
          )}

          {tab === 'approvals' && (
            <div className="nh-te__section">
              {draft.approvalRules.length === 0 && <p className="nh-te__empty">No approval rules yet.</p>}
              {draft.approvalRules.map((rule, i) => (
                <div className="nh-te__row" key={rule.id}>
                  <input
                    className="nh-te__input nh-te__input--wide"
                    placeholder='e.g. "always ask before submitting over $1,000"'
                    value={rule.description}
                    onChange={(e) => updateApprovalRule(i, e.target.value)}
                  />
                  <button type="button" className="nh-te__icon-btn" onClick={() => removeApprovalRule(i)} title="Remove rule">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="nh-te__add-btn" onClick={addApprovalRule}>
                + Add rule
              </button>
            </div>
          )}

          {tab === 'steps' && (
            <div className="nh-te__section">
              {draft.steps.length === 0 && <p className="nh-te__empty">No steps yet.</p>}
              {draft.steps.map((step, i) => (
                <div className="nh-te__row nh-te__step-row" key={step.id}>
                  <div className="nh-te__step-order">
                    <button type="button" className="nh-te__icon-btn" onClick={() => moveStep(i, -1)} disabled={i === 0} title="Move up">
                      ↑
                    </button>
                    <button
                      type="button"
                      className="nh-te__icon-btn"
                      onClick={() => moveStep(i, 1)}
                      disabled={i === draft.steps.length - 1}
                      title="Move down"
                    >
                      ↓
                    </button>
                  </div>
                  <input
                    className="nh-te__input"
                    placeholder="Step name"
                    value={step.name}
                    onChange={(e) => updateStep(i, { name: e.target.value })}
                  />
                  <input
                    className="nh-te__input nh-te__input--wide"
                    placeholder="Description"
                    value={step.description}
                    onChange={(e) => updateStep(i, { description: e.target.value })}
                  />
                  <button
                    type="button"
                    className={'nh-te__gate-btn' + (step.humanGate ? ' nh-te__gate-btn--on' : '')}
                    onClick={() => updateStep(i, { humanGate: !step.humanGate })}
                    title={step.humanGate ? 'Human approval required — click to make automatic' : 'Automatic — click to require human approval'}
                  >
                    {step.humanGate ? '🔒 human gate' : '🔓 automatic'}
                  </button>
                  <button type="button" className="nh-te__icon-btn" onClick={() => removeStep(i)} title="Remove step">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="nh-te__add-btn" onClick={addStep}>
                + Add step
              </button>
            </div>
          )}

          {tab === 'chains' && (
            <div className="nh-te__section nh-te__chains">
              <div className="nh-te__chain-list">
                {chains.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={'nh-te__chain-tab' + (c.id === activeChainId ? ' nh-te__chain-tab--active' : '')}
                    onClick={() => setActiveChainId(c.id)}
                  >
                    {c.name || 'Untitled chain'}
                  </button>
                ))}
                <button type="button" className="nh-te__add-btn" onClick={addChain}>
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
                      onChange={(e) => renameChain(activeChain.id, e.target.value)}
                    />
                    <button type="button" className="nh-te__icon-btn" onClick={() => removeChain(activeChain.id)} title="Remove chain">
                      ✕
                    </button>
                  </div>

                  {activeChain.entries.map((entry, i) => (
                    <div className="nh-te__row" key={entry.id}>
                      <div className="nh-te__step-order">
                        <button
                          type="button"
                          className="nh-te__icon-btn"
                          onClick={() => moveChainEntry(activeChain.id, i, -1)}
                          disabled={i === 0}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="nh-te__icon-btn"
                          onClick={() => moveChainEntry(activeChain.id, i, 1)}
                          disabled={i === activeChain.entries.length - 1}
                          title="Move down"
                        >
                          ↓
                        </button>
                      </div>
                      <input
                        className="nh-te__input nh-te__input--wide"
                        placeholder="Title template, e.g. Draft outreach #{{n}}"
                        value={entry.titleTemplate}
                        onChange={(e) => updateChainEntry(activeChain.id, i, { titleTemplate: e.target.value })}
                      />
                      <button
                        type="button"
                        className={'nh-te__gate-btn' + (entry.humanGate ? ' nh-te__gate-btn--on' : '')}
                        onClick={() => updateChainEntry(activeChain.id, i, { humanGate: !entry.humanGate })}
                        title="Toggle human gate"
                      >
                        {entry.humanGate ? '🔒' : '🔓'}
                      </button>
                      <button
                        type="button"
                        className="nh-te__icon-btn"
                        onClick={() => removeChainEntry(activeChain.id, i)}
                        title="Remove step"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button type="button" className="nh-te__add-btn" onClick={() => addChainEntry(activeChain.id)}>
                    + Add step to chain
                  </button>

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

          {tab === 'preview' && (
            <div className="nh-te__section">
              <p className="nh-te__hint">This is what the new-task form will ask for, from the current fields:</p>
              <div className="nh-te__form-preview">
                <div className="nh-te__form-row nh-te__form-row--builtin">
                  <span className="nh-te__form-label">Title</span>
                  <span className="nh-te__form-control nh-te__form-control--placeholder">Task title…</span>
                </div>
                {draft.fields.length === 0 && (
                  <p className="nh-te__empty">No custom fields — the form only asks for a title.</p>
                )}
                {draft.fields.map((field) => (
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

        <div className="nh-modal__footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => onSave(draft)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
