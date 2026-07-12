// task-d8a0b081eb93 — SavedQuery AUTHORING actions for the persistent Home
// sidebar Copilot (docs/saved-queries-design.md, "Authoring flow (CopilotKit)"
// + Addendum §1). An admin describes a data-source query in chat; Copilot —
// grounded here with the DataSource spec and the executor's code-contract —
// drafts the query code + outputSchema, tests it, and the human APPROVES it
// through a mandatory approve/reject card. Approval is the design-time gate AND
// the publish step (draft→approved makes the version org-visible).
//
// This mounts alongside <CopilotActions/> / <TaskActions/> / <NavActions/> in
// CopilotDock.tsx. Every action talks to the SAME window.fm bridge the rest of
// the app uses (src/copilot/savedQueries.ts helpers → fm.typebuild.*), mirroring
// the execute/list typeahead pattern (task-e713f307c422) — no parallel infra.
//
// DRAFT-PREVIEW vs the approved-only executor gate (deliberate v1 choice):
// the server's executor REFUSES to run a non-approved version — `POST
// /queries/:id/execute` on a draft returns 409 not_approved even for the author
// (there is no author dry-run/preview affordance server-side). We do NOT weaken
// that gate from the client. So the flow is: draft → (the human eyeballs the
// generated code + outputSchema, surfaced by draft_saved_query and shown again
// in the approve card) → approve → THEN test_saved_query runs live sample rows.
// test_saved_query still WORKS before approval — it just surfaces the 409
// clearly and tells the admin to approve first, rather than silently failing.
// This keeps "only approved code ever executes" true end-to-end.
//
// PHI: query code + outputSchema are NON-PHI author config (safe to show in
// chat / approve card). Sample rows from a test run are the dummy source's data
// and are rendered in chat memory-only — never logged here (row VALUES are not
// echoed into any log; only counts/labels reach the transcript the user sees).
import { useEffect, useRef, useState } from 'react';
import { useAgentContext } from '@copilotkit/react-core/v2';
import { z } from 'zod';
import { confirmedAction, immediateAction } from './actionKit';
import { useNewHomeContext } from './newHomeContext';
import {
  approveQuery,
  createDraftQuery,
  getQuery,
  listDataSources,
  newQueryVersion,
  registerDataSource,
  rowLabel,
  type DataSourceSummary,
  type QueryRow,
} from './savedQueries';
import { fm } from '../bridge';

// The executor's code-contract, surfaced verbatim to the LLM as grounding so
// the code it authors fits the sandbox (docs/saved-queries-design.md, "Code
// contract"). Kept terse — this rides into the system prompt.
const CODE_CONTRACT = [
  'SavedQuery code contract (the sandboxed executor runs exactly this):',
  '• A single default-exported async function: `export default async function run(ctx) { ... }`.',
  '• `ctx.fetch(path)` is the ONLY I/O. It is GET-only, scoped to the DataSource base_url',
  '  (an absolute URL, protocol-relative //host, or ../ path-climb is REFUSED), and the',
  '  executor injects credentials server-side — never put auth/keys in the code.',
  '• `ctx.inputs` holds the validated bound parameters (e.g. ctx.inputs.q for a search term).',
  '• NO ambient network/fs/timers/require/process/Buffer/import — only `ctx` exists.',
  '• Return `{ rows: [...] }`. EVERY row MUST carry a `ref: { entityType, externalId }`',
  '  (the executor stamps sourceId); other fields are display data.',
  '• Declare `outputSchema` = { ref: { entityType }, display: [fieldNames], fields: {name: type} }.',
  '  It is validated against the rows and fails loudly on drift.',
  '• Limits (executor-enforced): { timeoutMs, maxFetches, maxRows }. Filter server-side to stay under maxRows.',
].join('\n');

/** Mount once inside the CopilotKit provider (CopilotDock.tsx), alongside
 *  <CopilotActions/>. Registers the SavedQuery authoring actions + grounds the
 *  LLM with the DataSource registry and the executor code-contract.
 *
 *  These are ADMIN / design-time actions: available only on the Home
 *  surface (where the admin configures projects), matching how the other
 *  New-Home-scoped actions gate. */
export function SavedQueryAuthoringActions() {
  const nh = useNewHomeContext();
  const onNewHome = nh.surface === 'new-home';

  // Fetch the DataSource registry once (and on sign-in changes are rare enough
  // that a manual list_data_sources call covers refresh). Held in a ref too so
  // the once-registered action handlers read the latest list, not a stale
  // first-render snapshot (see NavActions stale-closure note).
  const [dataSources, setDataSources] = useState<DataSourceSummary[]>([]);
  const [dsError, setDsError] = useState<string | null>(null);
  const live = useRef<{ dataSources: DataSourceSummary[] }>({ dataSources: [] });
  live.current.dataSources = dataSources;

  useEffect(() => {
    if (!onNewHome) return;
    let cancelled = false;
    listDataSources()
      .then((ds) => {
        if (!cancelled) {
          setDataSources(ds);
          setDsError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setDsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [onNewHome]);

  // Ground the LLM: the available DataSources (name/base_url/entity_types — the
  // "API spec" it writes code against) + the code-contract rules. NON-PHI.
  useAgentContext({
    description:
      'SavedQuery authoring context: the registered external DataSources available to write ' +
      'live-API queries against (name, base_url, entity_types — NO credentials), and the ' +
      "sandboxed executor's code contract that authored query code MUST satisfy.",
    value: {
      dataSources: dataSources.map((d) => ({
        id: d.id,
        name: d.name,
        baseUrl: d.baseUrl,
        entityTypes: d.entityTypes,
      })),
      codeContract: CODE_CONTRACT,
      note: !onNewHome
        ? 'Open Home to author SavedQueries.'
        : dsError
          ? `Could not load DataSources (${dsError}); ask the user to check sign-in, or call list_data_sources to retry.`
          : 'Authoring actions are available on this surface.',
    },
  });

  // ─── list_data_sources — refreshable grounding the agent can call ─────────
  immediateAction({
    name: 'list_data_sources',
    available: onNewHome,
    description:
      'List the registered external DataSources you can write a SavedQuery against ' +
      '(name, base URL, and entity types — no credentials). Call this before drafting a query ' +
      'to pick the right sourceId and know which entity types the source exposes.',
    perform: async () => {
      try {
        const ds = await listDataSources();
        setDataSources(ds);
        if (ds.length === 0) return 'No DataSources are registered yet.';
        return (
          'Available DataSources:\n' +
          ds
            .map(
              (d) =>
                `• ${d.name} (id: ${d.id}) — base ${d.baseUrl || '(unset)'} — entities: ${
                  d.entityTypes.length ? d.entityTypes.join(', ') : '(none declared)'
                }`,
            )
            .join('\n')
        );
      } catch (e) {
        return `Failed to list DataSources: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── register_data_source — register an external API (confirmedAction) ────
  // task-a586c9ac4c90 — the FIRST half of "register an API + author a query
  // over it": mints the sourceId draft_saved_query needs. It is a side-effecting
  // write that may carry a CREDENTIAL (auth), so it is confirmed-gated — the
  // human approves the exact name/base_url/entity_types before it is created,
  // and perform() runs only on Approve. On success we refresh the DataSource
  // list so the new source is immediately groundable for authoring in THIS same
  // conversation. The auth blob is never rendered in the card or logged; only
  // its presence is acknowledged.
  confirmedAction({
    name: 'register_data_source',
    available: onNewHome,
    description:
      'Register an external REST API as a DataSource so SavedQueries can be authored against it. ' +
      'This mints a sourceId you then pass to draft_saved_query. Provide a short name, the API base ' +
      'URL, and the entity types it exposes (e.g. patient, appointment). If the API needs a ' +
      'credential, pass `auth` as a JSON string (e.g. {"type":"bearer","token":"..."}); it is sent ' +
      'once and stored server-side, never echoed back. Always requires the human to click Approve.',
    parameters: z.object({
      name: z.string().describe('Short human name for the source, e.g. "Scheduling API".'),
      baseUrl: z
        .string()
        .describe('The API base URL, e.g. "https://sched.example.com/api". Queries fetch relative to it.'),
      entityTypes: z
        .string()
        .describe('Comma-separated entity types the API exposes, e.g. "patient, appointment".'),
      spec: z
        .string()
        .optional()
        .describe('Optional JSON string describing the API spec (endpoints/shape) for grounding.'),
      auth: z
        .string()
        .optional()
        .describe('Optional JSON string credential, e.g. {"type":"bearer","token":"..."}. Sent once, never echoed.'),
    }),
    title: 'Register external DataSource?',
    summary: ({ name, baseUrl, entityTypes, auth }) => {
      const types = (entityTypes ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      return (
        <>
          Register <strong>{(name ?? '').trim() || '(unnamed)'}</strong> as a DataSource? SavedQueries
          will be authored against it.
          <div className="ck-confirm-note" style={{ marginTop: 6 }}>
            Base URL: <code>{(baseUrl ?? '').trim() || '(unset)'}</code>
            <br />
            Entities: {types.length ? types.join(', ') : '(none)'}
            <br />
            Credential: {auth && auth.trim() ? 'provided (stored server-side, not shown)' : 'none'}
          </div>
        </>
      );
    },
    confirmLabel: 'Register',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Not registered — no DataSource was created.',
    validate: ({ name, baseUrl, entityTypes, spec, auth }) => {
      if (!(name ?? '').trim()) return 'Failed: a source name is required.';
      if (!(baseUrl ?? '').trim()) return 'Failed: a base URL is required.';
      if (!(entityTypes ?? '').trim()) return 'Failed: at least one entity type is required.';
      // Fail fast on malformed JSON so the human never approves an unparseable
      // spec/auth (parsed again in perform, but this keeps the card honest).
      try {
        if (spec) JSON.parse(spec);
        if (auth) JSON.parse(auth);
      } catch {
        return 'Failed: spec/auth, when provided, must be valid JSON.';
      }
      return null;
    },
    perform: async ({ name, baseUrl, entityTypes, spec, auth }) => {
      const types = entityTypes
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      let parsedSpec: unknown;
      let parsedAuth: unknown;
      try {
        if (spec) parsedSpec = JSON.parse(spec);
        if (auth) parsedAuth = JSON.parse(auth);
      } catch {
        return 'Failed: spec/auth, when provided, must be valid JSON.';
      }
      try {
        const ds = await registerDataSource({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          entityTypes: types,
          spec: parsedSpec,
          auth: parsedAuth,
        });
        // Refresh grounding so the new source is usable for authoring right away.
        try {
          const refreshed = await listDataSources();
          setDataSources(refreshed);
          setDsError(null);
        } catch {
          /* non-fatal: the source is registered; grounding refresh can retry */
        }
        return (
          `Registered DataSource "${ds.name}" (id: ${ds.id}) — base ${ds.baseUrl || '(unset)'} — ` +
          `entities: ${ds.entityTypes.length ? ds.entityTypes.join(', ') : '(none declared)'}. ` +
          `Author a SavedQuery over it with draft_saved_query using sourceId ${ds.id}.`
        );
      } catch (e) {
        return `Failed to register DataSource: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── draft_saved_query — create a DRAFT (reversible / low-risk) ───────────
  immediateAction({
    name: 'draft_saved_query',
    available: onNewHome,
    description:
      'Create a DRAFT SavedQuery from code you author against a DataSource. The draft is ' +
      'private to you until a human approves it. Write `code` as the `export default async ' +
      'function run(ctx){...}` contract (call list_data_sources first for the sourceId + ' +
      'entity types), and declare `outputSchema` with a ref.entityType, display fields, and ' +
      "field types. After drafting, show the human the code and test it, then approve. " +
      'A draft cannot be executed until approved (the executor refuses non-approved versions).',
    parameters: z.object({
      name: z.string().describe('Short kebab-case query name, e.g. "patients-pending-surgery".'),
      sourceId: z.string().describe('The DataSource id to run against (from list_data_sources).'),
      code: z
        .string()
        .describe('The query body: `export default async function run(ctx) { ... return { rows }; }`.'),
      outputSchema: z
        .string()
        .describe(
          'JSON string of the outputSchema: {"ref":{"entityType":"..."},"display":[...],"fields":{...}}.',
        ),
      inputs: z
        .string()
        .optional()
        .describe('Optional JSON string: JSON Schema for bound inputs (e.g. the search term "q").'),
      limits: z
        .string()
        .optional()
        .describe('Optional JSON string of limits, e.g. {"timeoutMs":10000,"maxFetches":20,"maxRows":200}.'),
    }),
    perform: async ({ name, sourceId, code, outputSchema, inputs, limits }) => {
      const trimmedName = (name ?? '').trim();
      if (!trimmedName) return 'Failed: a query name is required.';
      if (!(sourceId ?? '').trim()) return 'Failed: a sourceId is required (see list_data_sources).';
      if (!(code ?? '').trim()) return 'Failed: query code is required.';
      let parsedSchema: unknown;
      try {
        parsedSchema = JSON.parse(outputSchema);
      } catch {
        return 'Failed: outputSchema must be valid JSON.';
      }
      // Minimal shape validation — the server validates fully, but catch the
      // common miss (no ref.entityType) here so the LLM gets a fast, precise fix.
      const schemaObj = parsedSchema as { ref?: { entityType?: unknown } };
      if (!schemaObj || typeof schemaObj !== 'object' || !schemaObj.ref?.entityType) {
        return 'Failed: outputSchema must include ref.entityType (every row carries a resource ref).';
      }
      let parsedInputs: unknown;
      let parsedLimits: unknown;
      try {
        if (inputs) parsedInputs = JSON.parse(inputs);
        if (limits) parsedLimits = JSON.parse(limits);
      } catch {
        return 'Failed: inputs/limits, when provided, must be valid JSON.';
      }
      try {
        const draft = await createDraftQuery({
          name: trimmedName,
          sourceId: sourceId.trim(),
          code,
          outputSchema: parsedSchema,
          inputs: parsedInputs,
          limits: parsedLimits,
          projectId: nh.project?.id || undefined,
        });
        return (
          `Created draft SavedQuery "${draft.name}" (id: ${draft.id}, version ${draft.version}, ` +
          `status: ${draft.status}). Show the human this code for review, then approve it with ` +
          `approve_saved_query before it can run. (Drafts cannot be executed until approved.)`
        );
      } catch (e) {
        return `Failed to create draft: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── test_saved_query — run the query and show SAMPLE ROWS inline ─────────
  // The executor refuses a non-approved version (409 not_approved). We surface
  // that clearly (approve first) rather than weakening the gate. After approval
  // this returns live sample rows so the admin can eyeball results.
  immediateAction({
    name: 'test_saved_query',
    available: onNewHome,
    description:
      'Run a SavedQuery against the sandbox and show a few sample rows so the human can see ' +
      'results. NOTE: the executor only runs APPROVED queries — testing a draft returns a ' +
      '"not approved" error, in which case review the code and approve it first, then test.',
    parameters: z.object({
      queryId: z.string().describe('The SavedQuery id to test.'),
      inputs: z
        .string()
        .optional()
        .describe('Optional JSON string of inputs, e.g. {"q":"smith"} for a search term.'),
    }),
    perform: async ({ queryId, inputs }) => {
      if (!(queryId ?? '').trim()) return 'Failed: a queryId is required.';
      let parsedInputs: Record<string, string> = {};
      if (inputs) {
        try {
          const obj = JSON.parse(inputs) as Record<string, unknown>;
          // executeQuery's inputs are string-valued (search terms); coerce.
          parsedInputs = Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
          );
        } catch {
          return 'Failed: inputs, when provided, must be valid JSON.';
        }
      }
      try {
        const rows = (await fm.typebuild.queries.execute(queryId.trim(), parsedInputs)) as QueryRow[];
        if (rows.length === 0) return `The query ran but returned 0 rows for those inputs.`;
        const sample = rows.slice(0, 5);
        const lines = sample.map((r, i) => `  ${i + 1}. ${rowLabel(r)} — ref ${r.ref.externalId}`);
        const more = rows.length > sample.length ? `\n  …and ${rows.length - sample.length} more.` : '';
        return `The query returned ${rows.length} row(s). Sample:\n${lines.join('\n')}${more}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The executor gate: a draft (or any non-approved version) 409s. Turn
        // that into a clear next-step rather than an opaque failure.
        if (/\b409\b|not_approved|not approved/i.test(msg)) {
          return (
            'This query is not approved yet, so the executor will not run it. Show the human the ' +
            'generated code + outputSchema, get it approved (approve_saved_query), then test again. ' +
            '(The approved-only execution gate is enforced by the server and must not be bypassed.)'
          );
        }
        return `Failed to test the query: ${msg}`;
      }
    },
  });

  // ─── approve_saved_query — THE mandatory human gate (confirmedAction) ─────
  // NEVER auto-approves: confirmedAction renders an approve/reject card and
  // perform() runs ONLY on the human clicking Approve. The summary shows the
  // query name + a code preview so the human knows exactly what they publish.
  // Approval == publish (draft→approved makes the version org-visible).
  confirmedAction({
    name: 'approve_saved_query',
    available: onNewHome,
    description:
      'Approve a DRAFT SavedQuery. This is the human design-time gate: it freezes the version, ' +
      'lets the executor run it, AND publishes it to everyone in the project (approval == publish). ' +
      'It always requires the human to click Approve on a review card — it is never automatic.',
    parameters: z.object({
      queryId: z.string().describe('The SavedQuery id to approve.'),
    }),
    title: 'Approve & publish SavedQuery?',
    summary: ({ queryId }) => <ApproveSummary queryId={queryId} />,
    confirmLabel: 'Approve & publish',
    rejectLabel: 'Cancel',
    rejectedMessage: 'Not approved — the query stays a private draft.',
    validate: ({ queryId }) => {
      if (!(queryId ?? '').trim()) return 'Failed: a queryId is required.';
      return null;
    },
    perform: async ({ queryId }) => {
      try {
        const q = await approveQuery(queryId.trim());
        return (
          `Approved "${q.name}" (id: ${q.id}, version ${q.version}) — status: ${q.status}` +
          `${q.approvedBy ? `, approved by ${q.approvedBy}` : ''}. It is now runnable and shared ` +
          `with the project.`
        );
      } catch (e) {
        return `Failed to approve: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // ─── new_query_version — clone→draft for iterate-in-chat (nice-to-have) ───
  immediateAction({
    name: 'new_query_version',
    available: onNewHome,
    description:
      'Clone an existing SavedQuery to a NEW DRAFT version (v+1) so you can iterate on the code ' +
      'or schema without changing the approved version. Provide only the fields you want to change.',
    parameters: z.object({
      queryId: z.string().describe('The SavedQuery id to clone into a new draft.'),
      code: z.string().optional().describe('Optional replacement query code.'),
      outputSchema: z.string().optional().describe('Optional replacement outputSchema (JSON string).'),
      inputs: z.string().optional().describe('Optional replacement inputs schema (JSON string).'),
      limits: z.string().optional().describe('Optional replacement limits (JSON string).'),
    }),
    perform: async ({ queryId, code, outputSchema, inputs, limits }) => {
      if (!(queryId ?? '').trim()) return 'Failed: a queryId is required.';
      const patch: { code?: string; outputSchema?: unknown; inputs?: unknown; limits?: unknown } = {};
      try {
        if (code !== undefined) patch.code = code;
        if (outputSchema) patch.outputSchema = JSON.parse(outputSchema);
        if (inputs) patch.inputs = JSON.parse(inputs);
        if (limits) patch.limits = JSON.parse(limits);
      } catch {
        return 'Failed: outputSchema/inputs/limits, when provided, must be valid JSON.';
      }
      try {
        const draft = await newQueryVersion(queryId.trim(), patch);
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

/** Approve-card summary — fetches the draft's code so the human sees exactly
 *  what they are approving (and publishing). Code + schema are NON-PHI. Shows a
 *  loading line while fetching; falls back to the id if the fetch fails. */
function ApproveSummary({ queryId }: { queryId: string }) {
  const [q, setQ] = useState<{ name: string; version: number; status: string; code: string } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getQuery(queryId)
      .then((res) => {
        if (!cancelled) setQ({ name: res.name, version: res.version, status: res.status, code: res.code });
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [queryId]);

  if (err) {
    return (
      <>
        Approve &amp; publish query <code>{queryId}</code>? (couldn't load its code preview: {err})
      </>
    );
  }
  if (!q) {
    return (
      <>
        Approve &amp; publish query <code>{queryId}</code>? Loading its code for review…
      </>
    );
  }
  const preview = q.code.length > 1200 ? `${q.code.slice(0, 1200)}\n… (truncated)` : q.code;
  return (
    <>
      Approve and <strong>publish</strong> <strong>{q.name}</strong> (version {q.version}, currently{' '}
      {q.status})? This freezes the version, lets it execute, and shares it with everyone in the
      project.
      <pre className="ck-confirm-note" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
        {preview}
      </pre>
    </>
  );
}
