// task-ce125a047c70 — agent-conducted New Task interview. Replaces
// NewTaskModal's deterministic ConversationDriver with a real LLM (Haiku,
// via the shared CopilotKit runtime) when Copilot is configured; the
// deterministic driver in NewTaskModal.tsx stays as the fallback when it
// isn't (see the copilotEnabled branch there).
//
// APPROACH CHOSEN: a scoped <CopilotChat> component (@copilotkit/react-ui),
// not a from-scratch UI driven by headless useCopilotChat. Rationale: the
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
import { CopilotKit, useCopilotAction, useCopilotAdditionalInstructions } from '@copilotkit/react-core';
import { CopilotChat } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import type { TemplateConfig, TemplateField } from '../components/newhome/types';

function fieldSpec(f: TemplateField): string {
  const bits = [`key="${f.key}"`, `label="${f.label}"`, `type=${f.type}`];
  if (f.required) bits.push('required');
  if (f.type === 'select' && f.options?.length) bits.push(`options=[${f.options.join(', ')}]`);
  if (f.agentFetchable) bits.push('you may try to infer/look this up instead of asking, if you can do so confidently');
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
    'Keep every question short (one sentence). When everything is collected, tell the user to review the panel on the right and press "Approve & Start Task".',
  );
  return lines.join('\n');
}

function FillFieldAction({
  template,
  onSetTitle,
  onSetValue,
}: {
  template: TemplateConfig;
  onSetTitle: (title: string) => void;
  onSetValue: (key: string, value: string) => void;
}) {
  useCopilotAdditionalInstructions({ instructions: buildInstructions(template) });

  useCopilotAction({
    name: 'fill_field',
    description:
      "Record the user's answer for the new task form. Use key \"title\" for the task title, or a template field's key for everything else. Call this immediately after the user answers, before asking the next question.",
    parameters: [
      { name: 'key', type: 'string', description: 'Either "title", or one of the template field keys.', required: true },
      { name: 'value', type: 'string', description: "The value the user gave for this field.", required: true },
    ],
    // Modal-scoped: only registered/enabled while NewTaskCopilotChat is
    // mounted (i.e. while the New Task modal is open), per task instructions.
    available: 'enabled',
    handler: async ({ key, value }) => {
      const v = (value ?? '').trim();
      if (!v) return `Ignored empty value for ${key}.`;
      if (key === 'title') {
        onSetTitle(v);
        return `Recorded title = "${v}".`;
      }
      const field = template.fields.find((f) => f.key === key);
      if (!field) return `Failed: unknown field key "${key}".`;
      onSetValue(key, v);
      return `Recorded ${field.label} = "${v}".`;
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
}: {
  runtimeUrl: string;
  template: TemplateConfig;
  onSetTitle: (title: string) => void;
  onSetValue: (key: string, value: string) => void;
}) {
  return (
    <CopilotKit runtimeUrl={runtimeUrl} useSingleEndpoint>
      <FillFieldAction template={template} onSetTitle={onSetTitle} onSetValue={onSetValue} />
      <CopilotChat
        className="nh-newtask__copilot-chat"
        labels={{
          title: 'New Task',
          initial: "What's this task about? Give me a short title.",
        }}
      />
    </CopilotKit>
  );
}
