// task-896f3f7f5e75 — type surface for the pure agent.mjs module (runtime is
// plain ESM so the node test runner imports it without a transpile step).

/** A NON-PHI agent registry entry, camelCased from the server row. `group` is
 *  optional (private agents have none → null). `tools` is free-form/advisory
 *  (display only). `launchMode` is one of chrome/auto/resume/manual (or any
 *  string the server sends). */
export type ClientAgent = {
  id: string;
  name: string;
  group: string | null;
  tools: string[];
  launchMode: string;
};

export const LAUNCH_MODES: readonly string[];

export function launchModeLabel(mode: unknown): string;

export function mapAgentRow(raw: unknown): ClientAgent | null;

export function mapAgentRows(rows: unknown): ClientAgent[];

export function mapResolvedAgent(raw: unknown): ClientAgent | null;

export function agentOptionHint(agent: ClientAgent | null | undefined): string;

export function agentDetailSummary(agent: ClientAgent | null | undefined): string;
