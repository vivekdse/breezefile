// task-ce125a047c70 — reusable gating layer for CopilotKit v2 tools.
//
// Built directly on CopilotKit's own v2 mechanisms (@copilotkit/react-core/v2)
// — NOT the legacy v1 `useCopilotAction` compatibility shim. Two flavors, so
// every action in this app declares its risk posture once, in one place,
// instead of re-implementing confirmation UX per action:
//
//   • immediateAction  — reversible UI actions (filter the roster, open a
//     task, add a column). Fire the instant the LLM calls them. Thin wrapper
//     over CopilotKit's `useFrontendTool` (the v2 hook for client-side
//     actions the agent can call) that standardizes returning a short,
//     unambiguous confirmation/error string to the chat transcript and
//     catches unexpected throws.
//
//   • confirmedAction  — destructive / irreversible / side-effecting actions.
//     Wraps CopilotKit's `useHumanInTheLoop` (the v2 hook for approval-gated
//     tools): when the LLM calls the action the chat shows a small
//     approve/reject card (reusing ConfirmDialog's visual language) and
//     cfg.perform runs ONLY if the human clicks Approve.
//
//     IMPORTANT: cfg.perform must resolve QUICKLY (do the side effect, or
//     kick off a UI flow the human continues elsewhere) — do NOT await a
//     human finishing a separate, unbounded flow (e.g. filling out and
//     submitting a form) before calling respond(). CopilotKit's tool-call
//     contract requires every tool_use to get a tool_result before the next
//     chat turn; if respond() is still pending when the user sends another
//     message, the run errors with "Tool result is missing for tool call
//     ...". Confirm-then-fire-and-report is fine; confirm-then-wait-for-a-
//     separate-human-workflow-to-finish is not.
//
// Parameters are Zod schemas (the v2 mechanism — StandardSchemaV1-compatible
// validators), not the legacy v1 array-of-{name,type,description} format.
//
// PHI: as in actions.tsx, params/results are already chat content the user
// authored — never additionally logged here. Return short strings so the
// transcript stays a clear audit trail of what actually happened.
import { useEffect, useRef, useState } from 'react';
import { useFrontendTool, useHumanInTheLoop } from '@copilotkit/react-core/v2';
import { ToolCallStatus } from '@copilotkit/core';
import type { z } from 'zod';
// Reuse the confirm dialog's button/typography classes (.confirm__title /
// __body / __actions / __btn*) for a consistent look. ConfirmDialog.css is
// also imported by the globally-mounted ConfirmDialog, but importing it here
// keeps actionKit self-contained (the bundler dedupes).
import '../components/ConfirmDialog.css';
import './actionKit.css';

/** Any Zod object schema whose parsed output is a plain record — what
 *  CopilotKit's FrontendTool<T> requires for T. `undefined` means "no
 *  parameters" (e.g. goto_new_home). */
type ParamsSchema = z.ZodType<Record<string, unknown>> | undefined;
type InferParams<S extends ParamsSchema> = S extends z.ZodType<infer T> ? T : Record<string, never>;

// ─── immediateAction ─────────────────────────────────────────────────────

interface ImmediateActionConfig<S extends ParamsSchema> {
  name: string;
  description: string;
  parameters?: S;
  /** Defaults to true (available). Set false to hide the tool from the agent
   *  without unregistering it — e.g. project/agent fields only for TypeBuild. */
  available?: boolean;
  /** Do the (reversible) thing and return a short confirmation string. May
   *  return a controlled failure string (e.g. "New Home isn't open …") too;
   *  unexpected throws are caught and formatted for you. */
  perform: (args: InferParams<S>) => string | Promise<string>;
}

/** Reversible action: fires as soon as the LLM calls it. Call this from
 *  inside a component mounted in the CopilotKit provider — it IS a hook
 *  (useFrontendTool) under the hood. */
export function immediateAction<S extends ParamsSchema = undefined>(
  cfg: ImmediateActionConfig<S>,
): void {
  useFrontendTool<InferParams<S>>({
    name: cfg.name,
    description: cfg.description,
    // Cast: useFrontendTool's `parameters` is StandardSchemaV1<any, T> keyed
    // to the same T the handler receives; our wrapper's InferParams<S> IS
    // that T by construction, but TS can't unify a still-generic S against
    // it structurally.
    parameters: cfg.parameters as z.ZodType<InferParams<S>> | undefined,
    available: cfg.available,
    handler: async (args) => {
      try {
        return await cfg.perform(args);
      } catch (e) {
        return `Failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}

// ─── confirmedAction ─────────────────────────────────────────────────────

interface ConfirmedActionConfig<S extends ParamsSchema> {
  name: string;
  description: string;
  parameters?: S;
  available?: boolean;
  /** Optional card heading (e.g. "Add template field?"). */
  title?: string;
  /** What the approve/reject card shows so the human knows exactly what
   *  they're approving — build it from the streamed args. */
  summary: (args: InferParams<S>) => React.ReactNode;
  /** Cheap, PURE precondition/validation check. Return an error string to
   *  reject the call outright (the card is skipped and the string is returned
   *  to the LLM straight away — no point asking a human to approve an
   *  impossible request); return null to proceed to the approve/reject card.
   *  Do NOT perform side effects here. */
  validate?: (args: InferParams<S>) => string | null;
  /** The actual side effect. Runs ONLY after the human clicks Approve.
   *  Returns the success string surfaced to the LLM; unexpected throws are
   *  caught and formatted. May be async. */
  perform: (args: InferParams<S>) => string | Promise<string>;
  confirmLabel?: string;
  rejectLabel?: string;
  /** Style the confirm button as destructive (red) — for irreversible loss. */
  destructive?: boolean;
  /** String returned to the LLM when the human rejects. */
  rejectedMessage?: string;
}

/** Confirmed action: renders a human-in-the-loop approve/reject card (via
 *  useHumanInTheLoop) and only runs cfg.perform on Approve. Same hook rules
 *  as immediateAction. See the perform() contract note in the file header —
 *  it must resolve quickly, not await a separate human workflow. */
export function confirmedAction<S extends ParamsSchema = undefined>(
  cfg: ConfirmedActionConfig<S>,
): void {
  useHumanInTheLoop<InferParams<S>>({
    name: cfg.name,
    description: cfg.description,
    parameters: cfg.parameters as z.ZodType<InferParams<S>> | undefined,
    available: cfg.available,
    render: (({ status, args, respond }) => {
      // inProgress: args still streaming — nothing to show yet.
      // complete: already resolved (respond called) — the outcome is in the
      // transcript, so render nothing.
      if (status !== ToolCallStatus.Executing || !respond) return <></>;
      const validationError = cfg.validate?.(args) ?? null;
      return (
        <ConfirmCard
          respond={respond}
          validationError={validationError}
          title={cfg.title}
          summary={cfg.summary(args)}
          confirmLabel={cfg.confirmLabel ?? 'Approve'}
          rejectLabel={cfg.rejectLabel ?? 'Reject'}
          destructive={cfg.destructive}
          perform={() => Promise.resolve(cfg.perform(args))}
          rejectedMessage={
            cfg.rejectedMessage ?? `Cancelled: "${cfg.name}" was not approved.`
          }
        />
      );
    }) as Parameters<typeof useHumanInTheLoop<InferParams<S>>>[0]['render'],
  });
}

function ConfirmCard({
  respond,
  validationError,
  title,
  summary,
  confirmLabel,
  rejectLabel,
  destructive,
  perform,
  rejectedMessage,
}: {
  respond: (result: unknown) => Promise<void>;
  validationError: string | null;
  title?: string;
  summary: React.ReactNode;
  confirmLabel: string;
  rejectLabel: string;
  destructive?: boolean;
  perform: () => Promise<string>;
  rejectedMessage: string;
}) {
  const [busy, setBusy] = useState(false);
  // Guard against double-respond (CopilotKit throws if respond is called
  // twice) across the async approve path and the auto-reject-on-invalid.
  const resolvedRef = useRef(false);

  function resolve(msg: string) {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    void respond(msg);
  }

  // A failed precondition means there is nothing for the human to approve —
  // auto-return the error to the LLM instead of showing a dead card. Done in
  // an effect (not during render) so respond's state update is well-behaved.
  useEffect(() => {
    if (validationError) resolve(validationError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationError]);

  if (validationError) return <></>;

  async function approve() {
    if (busy || resolvedRef.current) return;
    setBusy(true);
    let msg: string;
    try {
      msg = await perform();
    } catch (e) {
      msg = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    resolve(msg);
  }

  return (
    <div className="ck-confirm-card">
      {title && <div className="confirm__title">{title}</div>}
      <div className="confirm__body">{summary}</div>
      <div className="confirm__actions">
        <button
          type="button"
          className="confirm__btn confirm__btn--cancel"
          disabled={busy}
          onClick={() => resolve(rejectedMessage)}
        >
          {rejectLabel}
        </button>
        <button
          type="button"
          className={[
            'confirm__btn',
            destructive ? 'confirm__btn--destructive' : 'confirm__btn--primary',
          ].join(' ')}
          disabled={busy}
          onClick={() => void approve()}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
