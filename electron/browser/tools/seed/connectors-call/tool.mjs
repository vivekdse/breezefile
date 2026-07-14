// Seed tool for the `connectors` first-party MCP catalog server — see tool.json.
// channel:'mcp', so the runner (bin/breeze-tools.mjs runMcpSteps) supplies
// ctx.mcpCall(toolName, args) instead of a Playwright page; no browser opens.

function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    throw new Error('args must decode to a JSON object');
  } catch (e) {
    const err = new Error(`--args must be a JSON object string: ${e.message}`);
    err.category = 'validation_failed';
    throw err;
  }
}

export async function run(ctx, params) {
  const op = params.op;
  if (!op) {
    const err = new Error('missing required param: op');
    err.category = 'precondition_not_met';
    throw err;
  }

  const extra = parseArgs(params.args);
  const toolArgs = { ...extra };
  if (params.toolkit) toolArgs.toolkit = params.toolkit;
  if (params.method) toolArgs.method = params.method;
  if (params.path) toolArgs.path = params.path;

  const result = await ctx.mcpCall(op, toolArgs);
  return { result };
}
