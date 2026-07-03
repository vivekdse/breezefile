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
import type { TemplateField } from './types';
import type { TemplateConfigExt } from './newHomePrefs';
import { ChainStrip, type ChainStripStep } from './ChainStrip';
import { listApprovedQueries, type SavedQuerySummary } from '../../copilot/savedQueries';
import * as ops from './newHomeTemplateOps';
import './TemplateEditor.css';

export type CustomizeTab = 'fields' | 'columns' | 'approvals' | 'steps' | 'chains' | 'preview';

const TABS: { id: CustomizeTab; label: string }[] = [
  { id: 'fields', label: 'Fields' },
  { id: 'columns', label: 'Columns' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'steps', label: 'Steps' },
  { id: 'chains', label: 'Chains' },
  { id: 'preview', label: 'Preview' },
];

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

  function addChainAndSelect() {
    const { cfg, chainId } = ops.addChain(config);
    onChange(cfg);
    setActiveChainId(chainId);
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
                    className="nh-te__icon-btn"
                    onClick={() => onChange(ops.removeChain(config, activeChain.id))}
                    title="Remove chain"
                  >
                    ✕
                  </button>
                </div>

                {activeChain.entries.map((entry, i) => (
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
                    <input
                      className="nh-te__input nh-te__input--wide"
                      placeholder="Title template, e.g. Draft outreach #{{n}}"
                      value={entry.titleTemplate}
                      onChange={(e) => onChange(ops.updateChainEntry(config, activeChain.id, entry.id, { titleTemplate: e.target.value }))}
                    />
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
                ))}
                <button
                  type="button"
                  className="nh-te__add-btn"
                  onClick={() => onChange(ops.addChainEntry(config, activeChain.id))}
                >
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
