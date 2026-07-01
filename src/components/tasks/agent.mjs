// task-896f3f7f5e75 — pure agent-registry helpers (no React; runtime is plain
// ESM so the node test runner imports it without a transpile step). Both the
// TypeBuild source (agent-row mapping for listAgents / the resolved get_task
// block) and the composer/detail UI (option label + launch-mode display) reuse
// these so the shaping rules live in ONE place and are unit-testable.
//
// An AGENT is a NON-PHI registry entry: id, name, optional group (private
// agents allowed → group may be absent), a free-form advisory `tools` list
// (display only; no validation), and a `launch_mode` (chrome/auto/resume/
// manual). Server JSON is snake_case-ish already for these fields, but we map
// defensively so a malformed row can never throw or leak a bad shape into the
// picker.

// The launch_mode vocabulary (surfaced next to the agent name). Anything else
// the server sends is passed through verbatim (advisory), but only these get a
// friendly caption. task-896f3f7f5e75 locked this list.
export const LAUNCH_MODES = ['chrome', 'auto', 'resume', 'manual'];

// A short human caption for a launch_mode (used as the option hint). Unknown/
// absent modes fall back to the raw string (or '' when there's nothing).
export function launchModeLabel(mode) {
  switch (mode) {
    case 'chrome':
      return 'drives Chrome';
    case 'auto':
      return 'auto-accept';
    case 'resume':
      return 'resumes a session';
    case 'manual':
      return 'manual launch';
    default:
      return typeof mode === 'string' ? mode : '';
  }
}

// Map a raw server agent row → the camelCase client `ClientAgent`. Defensive:
// a non-object, or a row missing an id/name, yields null (dropped by the
// caller) so a malformed entry never reaches the picker. `group` is optional
// (private agents have none → null). `tools` is coerced to a string[] (advisory;
// non-array → []). `launchMode` passes through as a string (or '' when absent).
export function mapAgentRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!id || !name) return null;
  const group =
    typeof raw.group === 'string' && raw.group !== '' ? raw.group : null;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((t) => typeof t === 'string')
    : [];
  const launchMode =
    typeof raw.launch_mode === 'string'
      ? raw.launch_mode
      : typeof raw.launchMode === 'string'
        ? raw.launchMode
        : '';
  return { id, name, group, tools, launchMode };
}

// Map a LIST of raw agent rows → ClientAgent[], dropping malformed entries.
// Non-array input → [] (parse-miss safety, mirroring listProjects's `[]`).
export function mapAgentRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const a = mapAgentRow(r);
    if (a) out.push(a);
  }
  return out;
}

// The RESOLVED agent block inlined on get_task (task.agent). Same shape as a
// listed agent; pass through ONLY when well-shaped (an object with id + name),
// else null so a task with no/absent/malformed resolved agent renders exactly
// as today (NON-REGRESSION — the detail line is simply omitted).
export function mapResolvedAgent(raw) {
  return mapAgentRow(raw);
}

// The option HINT shown next to an agent's name in the picker: the launch mode
// caption. '' when there's no meaningful mode (the option still renders — just
// the name). Kept separate from the label so the UI can style them apart.
export function agentOptionHint(agent) {
  if (!agent) return '';
  return launchModeLabel(agent.launchMode);
}

// A compact one-line summary of the assigned agent for the detail panel:
// "Name · <launch caption>" when a mode is present, else just the name. Absent
// agent → '' (caller omits the row).
export function agentDetailSummary(agent) {
  if (!agent || !agent.name) return '';
  const hint = launchModeLabel(agent.launchMode);
  return hint ? `${agent.name} · ${hint}` : agent.name;
}
