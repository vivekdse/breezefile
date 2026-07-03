// task-ce125a047c70 — agent-conducted New Task interview. Replaces
// NewTaskModal's deterministic ConversationDriver with a real LLM (Haiku,
// via the shared CopilotKit runtime) when Copilot is configured; the
// deterministic driver in NewTaskModal.tsx stays as the fallback when it
// isn't (see the copilotEnabled branch there).
//
// APPROACH CHOSEN: a scoped <CopilotChat> component (CopilotKit v2,
// @copilotkit/react-core/v2), not a from-scratch UI driven by headless
// useCopilotChat. Rationale: the
// existing left pane's bubble/chip chrome is deterministic-driver-specific
// (chips are driver-emitted suggestions, "thinking" beats are a fake-fetch
// affordance) and reproducing that around headless useCopilotChat would mean
// re-deriving a chat UI CopilotKit already ships, for no behavioral gain —
// the interview's real state of record is the FORM (title/values), not the
// transcript. <CopilotChat> gives a complete, accessible chat UI for free;
// the actual "driver" contract (advance one field at a time, write into the
// form) is entirely the `fill_field` action + system instructions below, so
// swapping to a headless implementation later (if the chat chrome needs to
// diverge further from CopilotKit's own) only touches this file.
//
// The right-hand form preview panel is unchanged and remains the single
// source of truth — `fill_field` is the ONLY channel through which the
// interview can affect it, so what's on the form is always exactly what the
// agent (or the user, by typing into the chat and getting confirmed by the
// agent) explicitly recorded.
import { useRef } from 'react';
import { CopilotKit, CopilotChat, useAgentContext } from '@copilotkit/react-core/v2';
import { z } from 'zod';
import { immediateAction } from './actionKit';
import type { TemplateConfig, TemplateField } from '../components/newhome/types';
import { executeQuery, rowLabel, type QueryRef, type QueryRow } from './savedQueries';

function fieldSpec(f: TemplateField): string {
  const bits = [`key="${f.key}"`, `label="${f.label}"`, `type=${f.type}`];
  if (f.required) bits.push('required');
  if (f.type === 'select' && f.options?.length) bits.push(`options=[${f.options.join(', ')}]`);
  if (f.source)
    bits.push(
      'data-source-backed: DO NOT ask the user to type this; call lookup_record with fieldKey and the search term, show the matches, confirm which one, then fill_field it',
    );
  else if (f.agentFetchable)
    bits.push('you may try to infer/look this up instead of asking, if you can do so confidently');
  return `- ${bits.join(' ')}`;
}

function buildInstructions(template: TemplateConfig): string {
  const required = template.fields.filter((f) => f.required);
  const optional = template.fields.filter((f) => !f.required);
  const lines: string[] = [
    'You are conducting a short interview to fill out a new task form. The form has a title, plus these fields:',
  ];
  if (required.length) {
    lines.push('Required fields (ask about every one of these, one at a time, in this order):');
    lines.push(...required.map(fieldSpec));
  }
  if (optional.length) {
    lines.push('Optional fields (offer these after the required ones; the user may skip any of them):');
    lines.push(...optional.map(fieldSpec));
  }
  lines.push(
    'Rules: ask ONE question at a time — the task title first, then each required field in order, then optional fields.',
    'The instant the user answers a question, call the fill_field action with key set to "title" (for the title question) or the field\'s key, and value set to what they said, BEFORE asking the next question.',
    'If the user skips an optional field, do not call fill_field for it — just move on.',
    'For a data-source-backed field, use lookup_record (fieldKey + the term the user gives) to search the live source, present the returned matches, confirm the right one with the user, THEN call fill_field with that field\'s key and the chosen match\'s label — recording the underlying resource reference happens automatically.',
    'Keep every question short (one sentence). When everything is collected, tell the user to review the panel on the right and press "Approve & Start Task".',
  );
  return lines.join('\n');
}

function FillFieldAction({
  template,
  onSetTitle,
  onSetValue,
  onSelectRef,
}: {
  template: TemplateConfig;
  onSetTitle: (title: string) => void;
  onSetValue: (key: string, value: string) => void;
  onSelectRef: (fieldKey: string, label: string, ref: QueryRef) => void;
}) {
  // v2 has no useCopilotAdditionalInstructions equivalent; context items
  // (useAgentContext) are serialized into the model's system prompt the same
  // way instructions were, so this is the direct replacement.
  useAgentContext({
    description: 'Instructions for conducting this New Task interview.',
    value: buildInstructions(template),
  });

  // task-e713f307c422 — cache the rows from the last lookup_record per field so
  // a subsequent fill_field (the agent picking a match by its label) can attach
  // that row's opaque `ref` to the form — one lookup, two UIs (this and the
  // NewTaskModal typeahead). PHI: rows are held in memory only, never logged.
  const lastLookup = useRef<Record<string, QueryRow[]>>({});

  immediateAction({
    name: 'fill_field',
    description:
      "Record the user's answer for the new task form. Use key \"title\" for the task title, or a template field's key for everything else. Call this immediately after the user answers, before asking the next question. For a data-source-backed field, pass the LABEL of the match chosen from a prior lookup_record so its resource reference is attached automatically.",
    parameters: z.object({
      key: z.string().describe('Either "title", or one of the template field keys.'),
      value: z.string().describe('The value the user gave for this field.'),
    }),
    perform: ({ key, value }) => {
      const v = (value ?? '').trim();
      if (!v) return `Ignored empty value for ${key}.`;
      if (key === 'title') {
        onSetTitle(v);
        return `Recorded title = "${v}".`;
      }
      const field = template.fields.find((f) => f.key === key);
      if (!field) return `Failed: unknown field key "${key}".`;
      // Data-source-backed field: try to bind the ref from the cached lookup by
      // matching the chosen value against a row's label.
      if (field.source) {
        const rows = lastLookup.current[key] ?? [];
        const match =
          rows.find((r) => rowLabel(r) === v) ??
          rows.find((r) => rowLabel(r).toLowerCase() === v.toLowerCase());
        if (match) {
          onSelectRef(key, rowLabel(match), match.ref);
          return `Recorded ${field.label} = "${rowLabel(match)}" (linked to its source record).`;
        }
        // No matching cached row — record the label but flag the missing link
        // so the agent re-runs lookup_record and picks a real match.
        onSetValue(key, v);
        return `Recorded ${field.label} = "${v}", but no source record is linked — run lookup_record and fill_field with an exact match label.`;
      }
      onSetValue(key, v);
      return `Recorded ${field.label} = "${v}".`;
    },
  });

  immediateAction({
    name: 'lookup_record',
    description:
      'Search a data-source-backed field\'s live source for a term and return the top matching records. Use this for any field marked "data-source-backed" instead of asking the user to type the value. After the user confirms which match is right, call fill_field with that field\'s key and the match\'s exact label.',
    parameters: z.object({
      fieldKey: z.string().describe('The key of the data-source-backed template field to search.'),
      term: z.string().describe('The search term (e.g. a name) to look up.'),
    }),
    perform: async ({ fieldKey, term }) => {
      const field = template.fields.find((f) => f.key === fieldKey);
      if (!field) return `Failed: unknown field key "${fieldKey}".`;
      if (!field.source) return `Failed: field "${fieldKey}" is not data-source-backed.`;
      const q = (term ?? '').trim();
      if (!q) return `Ignored empty search term for ${field.label}.`;
      let rows: QueryRow[];
      try {
        rows = await executeQuery(field.source.savedQueryId, q, field.source.version);
      } catch (e) {
        return `Lookup failed for ${field.label}: ${e instanceof Error ? e.message : String(e)}`;
      }
      lastLookup.current[fieldKey] = rows;
      if (rows.length === 0) return `No matches for "${q}" in ${field.label}.`;
      // Return a short, unambiguous list (top 5) by label — the agent confirms
      // one with the user, then fill_field records it. Value-free beyond the
      // display labels the query already deems safe to render.
      const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${rowLabel(r)}`);
      return `Matches for "${q}" in ${field.label}:\n${top.join('\n')}\nConfirm which one, then fill_field ${fieldKey} with its exact label.`;
    },
  });

  return null;
}

/** Mounted only while the New Task modal is open and Copilot is enabled
 *  (see NewTaskModal.tsx). Runs in its own <CopilotKit> instance scoped to
 *  the modal's lifetime — separate from the sidebar's — so opening/closing
 *  the modal cleanly starts/tears down this interview's thread without
 *  disturbing the sidebar's ongoing conversation. */
export function NewTaskCopilotChat({
  runtimeUrl,
  template,
  onSetTitle,
  onSetValue,
  onSelectRef,
}: {
  runtimeUrl: string;
  template: TemplateConfig;
  onSetTitle: (title: string) => void;
  onSetValue: (key: string, value: string) => void;
  /** task-e713f307c422 — record a data-source-backed field's selected row
   *  (display snapshot + opaque ref) so the modal threads it onto the task
   *  `data`. Mirrors the typeahead's selection path — one lookup, two UIs. */
  onSelectRef: (fieldKey: string, label: string, ref: QueryRef) => void;
}) {
  return (
    <CopilotKit runtimeUrl={runtimeUrl} useSingleEndpoint>
      <FillFieldAction
        template={template}
        onSetTitle={onSetTitle}
        onSetValue={onSetValue}
        onSelectRef={onSelectRef}
      />
      <CopilotChat
        className="nh-newtask__copilot-chat"
        labels={{
          welcomeMessageText: "What's this task about? Give me a short title.",
        }}
      />
    </CopilotKit>
  );
}
