// task-ae0ec0348930 — FormExtension AUTHORING actions for the persistent Home
// sidebar Copilot (mirrors savedQueryAuthoring.tsx). An admin describes desired
// custom form BEHAVIOR in chat; Copilot — grounded here with the effect-shape
// contract and the available SavedQueries (so it can bind typeahead fields) —
// drafts the fields[] + a PURE logic function, tests it against sample values,
// and the human APPROVES it through a mandatory approve/reject card. Approval is
// the design-time gate (draft→approved) that lets the interpreter render it.
//
// This mounts alongside <SavedQueryAuthoringActions/> in CopilotDock.tsx. Every
// action talks to the SAME window.fm bridge (src/copilot/formExtensions.ts →
// fm.typebuild.formext.*), mirroring the SavedQuery authoring flow — no parallel
// infra.
//
// PHI: fields[] + logic are NON-PHI author config (safe to show in chat / the
// approve card). test_form_logic runs with SAMPLE values the admin provides
// (non-PHI dummy data) and shows the returned effects inline — effect keys/values
// are the config's behavior, not patient data.
import { useEffect, useRef, useState } from 'react';
import { useAgentContext } from '@copilotkit/react-core/v2';
import { z } from 'zod';
import { confirmedAction, immediateAction } from './actionKit';
import { useNewHomeContext } from './newHomeContext';
import {
  approveFormExtension,
  createFormExtension,
  getFormExtension,
  newFormExtensionVersion,
  runFormLogic,
  type FormExtension,
} from './formExtensions';
import { listApprovedQueries, type SavedQuerySummary } from './savedQueries';

// The effect-shape contract, surfaced verbatim to the LLM as grounding so the
// logic it authors returns only allowlisted effects and the fields[] it declares
// use known widgets. Terse — this rides into the system prompt.
const EFFECT_CONTRACT = [
  'FormExtension contract (the interpreter renders fields[] + applies the logic’s effects):',
  '• fields[] elements: { key, label, widget: "typeahead"|"select"|"text"|"date"|"number",',
  '  source?: { savedQueryId, version? } (ONLY for widget:"typeahead" — binds a SavedQuery),',
  '  options?: string[] (for widget:"select") }.',
  '• logic is a PURE function string. It gets the current field VALUES + the changed key and',
  '  returns an `effects` object. It does NO fetch/IO and has NO ambient globals — pure data in,',
  '  effects out. Dynamic data (typeahead options/rows) binds a SavedQuery via a field’s source.',
  '• effects has AT MOST these four keys, each a fieldKey→value map:',
  '    setValue:{k:v}     — write v into field k',
  '    setVisible:{k:b}   — show/hide field k',
  '    setOptions:{k:[…]} — replace field k’s select options',
  '    validate:{k:msg}   — inline error on k (null clears)',
  '  ANY other effect key is IGNORED by the interpreter (and stripped server-side).',
  '• applies_to (e.g. {"template":"intake"}) declares which form the extension attaches to.',
  '• A draft is private until APPROVED; only approved extensions are rendered by the interpreter.',
].join('\n');

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <SavedQueryAuthoringActions/>. Registers the FormExtension authoring actions
 *  + grounds the LLM with the effect contract and the available SavedQueries so
 *  it can bind typeahead fields. Home-surface only (design-time admin actions). */
export function FormExtensionAuthoringActions() {
  const nh = useNewHomeContext();
  const onNewHome = nh.surface === 'new-home';

  // The available SavedQueries the LLM can bind a typeahead field to (reuse the
  // selector list — same grounding the TemplateEditor source picker uses). Held
  // in a ref too so once-registered handlers read the latest list.
  const [queries, setQueries] = useState<SavedQuerySummary[]>([]);
  const [qErr, setQErr] = useState<string | null>(null);
  const live = useRef<{ queries: SavedQuerySummary[] }>({ queries: [] });
  live.current.queries = queries;

  useEffect(() => {
    if (!onNewHome) return;
    let cancelled = false;
    listApprovedQueries()
      .then((q) => {
        if (!cancelled) {
          setQueries(q);
          setQErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setQErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [onNewHome]);

  useAgentContext({
    description:
      'FormExtension authoring context: the effect-shape contract that authored logic + fields[] ' +
      'MUST satisfy (four allowlisted effect keys; logic is PURE, no fetch; dynamic data binds a ' +
      'SavedQuery), and the approved SavedQueries available to bind typeahead fields to.',
    value: {
      effectContract: EFFECT_CONTRACT,
      savedQueries: queries.map((q) => ({
        id: q.id,
        name: q.name,
        version: q.version,
        entityType: q.entityType ?? '',
      })),
      note: !onNewHome
        ? 'Open Home to author FormExtensions.'
        : qErr
          ? `Could not load SavedQueries (${qErr}); typeahead fields can’t be bound until sign-in is fixed.`
          : 'Authoring actions are available on this surface.',
    },
  });

  // ─── draft_form_extension — create a DRAFT (reversible / low-risk) ────────
  immediateAction({
    name: 'draft_form_extension',
    available: onNewHome,
    description:
      'Create a DRAFT FormExtension: extra form FIELDS + a PURE logic function that returns ' +
      'allowlisted effects (setValue/setVisible/setOptions/validate). The draft is private until a ' +
      'human approves it. Declare fields[] with a widget each (typeahead fields bind a SavedQuery ' +
      'via source.savedQueryId — see the grounded savedQueries list). Write `logic` as a pure ' +
      'function of the current values + changed key. Set applies_to (e.g. {"template":"intake"}). ' +
      'After drafting, test it, then approve it before it renders.',
    parameters: z.object({
      name: z.string().describe('Short kebab-case name, e.g. "intake-conditional-fields".'),
      appliesTo: z
        .string()
        .describe('JSON string of applies_to, e.g. {"template":"intake"} — which form it attaches to.'),
      fields: z
        .string()
        .describe(
          'JSON array of field descriptors: [{"key","label","widget","source?":{"savedQueryId","version?"},"options?":[…]}].',
        ),
      logic: z
        .string()
        .describe('The PURE logic function string: given values + changed key, return an effects object.'),
      limits: z.string().optional().describe('Optional JSON string of limits.'),
    }),
    perform: async ({ name, appliesTo, fields, logic, limits }) => {
      const trimmedName = (name ?? '').trim();
      if (!trimmedName) return 'Failed: a name is required.';
      if (!(logic ?? '').trim()) return 'Failed: a logic function is required.';
      let parsedAppliesTo: Record<string, unknown>;
      let parsedFields: Array<Record<string, unknown>>;
      try {
        parsedAppliesTo = JSON.parse(appliesTo);
      } catch {
        return 'Failed: applies_to must be valid JSON (e.g. {"template":"intake"}).';
      }
      try {
        const arr = JSON.parse(fields);
        if (!Array.isArray(arr)) return 'Failed: fields must be a JSON array of field descriptors.';
        parsedFields = arr;
      } catch {
        return 'Failed: fields must be valid JSON (an array of field descriptors).';
      }
      let parsedLimits: Record<string, unknown> | undefined;
      try {
        if (limits) parsedLimits = JSON.parse(limits);
      } catch {
        return 'Failed: limits, when provided, must be valid JSON.';
      }
      try {
        const draft = await createFormExtension({
          name: trimmedName,
          appliesTo: parsedAppliesTo,
          fields: parsedFields,
          logic,
          limits: parsedLimits,
          projectId: nh.project?.id || undefined,
        });
        return (
          `Created draft FormExtension "${draft.name}" (id: ${draft.id}, version ${draft.version}, ` +
          `status: ${draft.status}) with ${draft.fields.length} field(s). Test it with ` +
          `test_form_logic, then approve it with approve_form_extension before it renders. ` +
          `(Drafts are private and not rendered until approved.)`
        );
      } catch (e) {
        return `Failed to create draft: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── test_form_logic — run-logic with sample values, show effects inline ──
  immediateAction({
    name: 'test_form_logic',
    available: onNewHome,
    description:
      'Run a FormExtension’s logic against SAMPLE values and show the returned effects so the human ' +
      'can see what it does. Provide the sample `values` and optionally the `changed` field key. The ' +
      'effects are the four allowlisted kinds (setValue/setVisible/setOptions/validate).',
    parameters: z.object({
      id: z.string().describe('The FormExtension id to test.'),
      values: z.string().describe('JSON object of sample field values, e.g. {"age":"64"}.'),
      changed: z
        .string()
        .optional()
        .describe('Optional field key that "just changed" (drives change-triggered logic).'),
    }),
    perform: async ({ id, values, changed }) => {
      if (!(id ?? '').trim()) return 'Failed: an id is required.';
      let parsedValues: Record<string, unknown>;
      try {
        parsedValues = JSON.parse(values);
        if (!parsedValues || typeof parsedValues !== 'object' || Array.isArray(parsedValues)) {
          return 'Failed: values must be a JSON object of field values.';
        }
      } catch {
        return 'Failed: values must be valid JSON (an object of field values).';
      }
      try {
        const { effects, version } = await runFormLogic(
          id.trim(),
          parsedValues,
          (changed ?? '').trim() || null,
        );
        const keys = Object.keys(effects);
        if (keys.length === 0) {
          return `Logic ran (version ${version}) and returned no effects for those values.`;
        }
        return (
          `Logic ran (version ${version}). Effects:\n` +
          keys.map((k) => `• ${k}: ${JSON.stringify((effects as Record<string, unknown>)[k])}`).join('\n')
        );
      } catch (e) {
        return `Failed to run logic: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── approve_form_extension — THE mandatory human gate (confirmedAction) ──
  // NEVER auto-approves: confirmedAction renders an approve/reject card and
  // perform() runs ONLY on the human clicking Approve. The summary shows the
  // fields + logic preview so the human knows exactly what they publish.
  confirmedAction({
    name: 'approve_form_extension',
    available: onNewHome,
    description:
      'Approve a DRAFT FormExtension. This is the human design-time gate: it flips draft→approved so ' +
      'the interpreter renders it on the matching form. It always requires the human to click Approve ' +
      'on a review card showing the fields + logic — it is never automatic.',
    parameters: z.object({
      id: z.string().describe('The FormExtension id to approve.'),
    }),
    title: 'Approve FormExtension?',
    summary: ({ id }) => <ApproveSummary id={id} />,
    confirmLabel: 'Approve',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Not approved — the extension stays a private draft.',
    validate: ({ id }) => {
      if (!(id ?? '').trim()) return 'Failed: an id is required.';
      return null;
    },
    perform: async ({ id }) => {
      try {
        const fx = await approveFormExtension(id.trim());
        return (
          `Approved "${fx.name}" (id: ${fx.id}, version ${fx.version}) — status: ${fx.status}` +
          `${fx.approvedBy ? `, approved by ${fx.approvedBy}` : ''}. It will now render on the ` +
          `matching form.`
        );
      } catch (e) {
        return `Failed to approve: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── new_form_extension_version — clone→draft for iterate-in-chat ─────────
  immediateAction({
    name: 'new_form_extension_version',
    available: onNewHome,
    description:
      'Clone an existing FormExtension to a NEW DRAFT version (v+1) so you can iterate on its fields ' +
      'or logic without changing the approved version. Provide only the parts you want to change.',
    parameters: z.object({
      id: z.string().describe('The FormExtension id to clone into a new draft.'),
      fields: z.string().optional().describe('Optional replacement fields[] (JSON array).'),
      logic: z.string().optional().describe('Optional replacement logic function string.'),
      appliesTo: z.string().optional().describe('Optional replacement applies_to (JSON object).'),
      limits: z.string().optional().describe('Optional replacement limits (JSON object).'),
    }),
    perform: async ({ id, fields, logic, appliesTo, limits }) => {
      if (!(id ?? '').trim()) return 'Failed: an id is required.';
      const patch: {
        fields?: Array<Record<string, unknown>>;
        logic?: string;
        appliesTo?: Record<string, unknown>;
        limits?: Record<string, unknown>;
      } = {};
      try {
        if (fields) {
          const arr = JSON.parse(fields);
          if (!Array.isArray(arr)) return 'Failed: fields must be a JSON array.';
          patch.fields = arr;
        }
        if (logic !== undefined) patch.logic = logic;
        if (appliesTo) patch.appliesTo = JSON.parse(appliesTo);
        if (limits) patch.limits = JSON.parse(limits);
      } catch {
        return 'Failed: fields/applies_to/limits, when provided, must be valid JSON.';
      }
      try {
        const draft = await newFormExtensionVersion(id.trim(), patch);
        return (
          `Created draft version ${draft.version} of "${draft.name}" (id: ${draft.id}, status: ` +
          `${draft.status}). Test it, then approve it to publish the new version.`
        );
      } catch (e) {
        return `Failed to create new version: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  return null;
}

/** Approve-card summary — fetches the draft's fields + logic so the human sees
 *  exactly what they are approving. NON-PHI config. Shows a loading line while
 *  fetching; falls back to the id if the fetch fails. */
function ApproveSummary({ id }: { id: string }) {
  const [fx, setFx] = useState<FormExtension | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFormExtension(id)
      .then((res) => {
        if (!cancelled) setFx(res);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (err) {
    return (
      <>
        Approve FormExtension <code>{id}</code>? (couldn’t load its preview: {err})
      </>
    );
  }
  if (!fx) {
    return (
      <>
        Approve FormExtension <code>{id}</code>? Loading its fields + logic for review…
      </>
    );
  }
  const fieldsLine = fx.fields.map((f) => `${f.key} (${f.widget})`).join(', ') || '(no fields)';
  const logicPreview = fx.logic.length > 1200 ? `${fx.logic.slice(0, 1200)}\n… (truncated)` : fx.logic;
  return (
    <>
      Approve <strong>{fx.name}</strong> (version {fx.version}, currently {fx.status})? Once approved
      the interpreter renders it on the matching form.
      <div className="ck-confirm-note" style={{ marginTop: 6 }}>
        <strong>Fields:</strong> {fieldsLine}
      </div>
      <pre className="ck-confirm-note" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
        {logicPreview}
      </pre>
    </>
  );
}
