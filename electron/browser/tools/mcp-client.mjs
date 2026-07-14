// Minimal MCP-over-HTTP client for `mcp`-channel breeze-tools (task-7a398b0f44a4
// follow-up — arming the operator to use first-party MCP catalog tiles like
// `connectors`/`scheduling` via a fast CLI recipe instead of hand-rolled tool
// calls every session).
//
// WHY THIS EXISTS: an `mcp`-channel tool's steps need to call a first-party MCP
// server (e.g. https://connectors.typebuild.com/mcp) the SAME way the agent's
// own Claude session does when it invokes mcp__connectors__*, but from a plain
// Bash-spawned Node CLI, which has no MCP client of its own. Rather than
// bringing in a full MCP SDK, this speaks just enough of MCP-over-HTTP
// (JSON-RPC 2.0 `tools/call`, per the 2026 Streamable HTTP transport) to invoke
// one tool and read back its result — the CLI is a thin JSON-RPC client, not a
// full session (no initialize/notifications handshake retained across calls;
// each invocation is a fresh, stateless POST, which every first-party server
// here supports since a Connections-catalog tile is stateless per the existing
// connection-mount.ts contract).
//
// AUTH: first-party MCP tiles (auth:'first_party_mcp') accept the user's
// EXISTING minted TypeBuild session token — the same identity the `typebuild`
// MCP entry and connection-mount.ts's mounted first-party servers use. That
// token is already injected into every operator/task PTY's env as
// TYPEBUILD_MCP_TOKEN (electron/sources/typebuild.ts MCP_TOKEN_ENV), so this
// module just reads it from process.env — no separate mint, no vault lookup.

/** Env var carrying the minted TypeBuild session token — mirrors
 *  electron/sources/typebuild.ts's MCP_TOKEN_ENV. Set in every operator/task
 *  PTY; absent for an ad-hoc shell (callMcpTool then fails with a clear error
 *  rather than silently sending an unauthenticated request). */
export const MCP_TOKEN_ENV = 'TYPEBUILD_MCP_TOKEN';

/** Call one tool on a first-party MCP server over HTTP.
 *
 *  @param serviceUrl  the server's MCP endpoint (tool.json `service_url`,
 *                     e.g. "https://connectors.typebuild.com/mcp").
 *  @param toolName    the MCP tool to invoke (e.g. "call", "list_catalog").
 *  @param toolArgs    plain object of arguments for that tool.
 *  @param opts.token  override the bearer token (tests only); defaults to
 *                     process.env[MCP_TOKEN_ENV].
 *  @param opts.timeoutMs  abort after this long (default 30_000).
 *  @returns the tool's structured result (MCP `content`/`structuredContent`,
 *           flattened to plain data — see unwrapResult below).
 *  @throws  Error with a `.category` drawn from registry.mjs's ERROR_CATEGORY
 *           vocabulary ('auth_failed' | 'timeout' | 'unexpected_state') so
 *           callers can branch the same way a ToolError does. */
export async function callMcpTool(serviceUrl, toolName, toolArgs = {}, opts = {}) {
  const token = opts.token || process.env[MCP_TOKEN_ENV];
  if (!token) {
    const err = new Error(
      `${MCP_TOKEN_ENV} is not set — this CLI must run inside an operator/task session ` +
        `(or pass opts.token) to call a first-party MCP server`,
    );
    err.category = 'auth_failed';
    throw err;
  }
  if (!serviceUrl) {
    const err = new Error('mcp-client: serviceUrl is required');
    err.category = 'unexpected_state';
    throw err;
  }

  // The abort timer stays live across BOTH the connect/header phase AND the
  // body read below — clearing it as soon as fetch() resolves (headers
  // received) would leave a server that stalls mid-body completely
  // unbounded, since res.text() is a separate await with no timeout of its
  // own. One controller.signal governs the whole operation (per fetch/undici,
  // an abort also rejects an in-flight res.text()), so the timer must only be
  // cleared once the body read has actually finished (success or error).
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res;
    try {
      res = await fetch(serviceUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: toolName, arguments: toolArgs },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const err = new Error(`mcp-client: request to ${toolName} failed: ${e.message}`);
      err.category = e.name === 'AbortError' ? 'timeout' : 'unexpected_state';
      throw err;
    }

    if (res.status === 401) {
      const err = new Error(`mcp-client: ${toolName} rejected (401) — token expired or unauthorized`);
      err.category = 'auth_failed';
      throw err;
    }
    if (res.status === 403) {
      // 403 is ambiguous — a genuinely unauthorized token, but also commonly a
      // rate-limit/WAF/gateway block unrelated to credentials. Don't stamp
      // auth_failed (which tells the repair tier to "fix creds/session");
      // unexpected_state routes to escalation instead of a misleading retry.
      const err = new Error(`mcp-client: ${toolName} rejected (403) — forbidden (may be auth, rate-limit, or a gateway block)`);
      err.category = 'unexpected_state';
      throw err;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const err = new Error(`mcp-client: ${toolName} HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
      err.category = 'unexpected_state';
      throw err;
    }

    // Streamable HTTP may reply with a single JSON object OR one `data:` SSE
    // frame carrying it; accept either NON-PHI transport shape.
    let raw;
    try {
      raw = await res.text();
    } catch (e) {
      const err = new Error(`mcp-client: reading ${toolName}'s response failed: ${e.message}`);
      err.category = e.name === 'AbortError' ? 'timeout' : 'unexpected_state';
      throw err;
    }
    const json = parseJsonRpcBody(raw);
    if (!json) {
      const err = new Error(`mcp-client: ${toolName} returned an unparseable response`);
      err.category = 'unexpected_state';
      throw err;
    }
    if (json.error) {
      const err = new Error(`mcp-client: ${toolName} error: ${json.error.message || JSON.stringify(json.error)}`);
      err.category = 'unexpected_state';
      err.extra = json.error;
      throw err;
    }
    const result = json.result || {};
    if (result.isError) {
      const err = new Error(`mcp-client: ${toolName} tool error: ${summarizeContent(result.content)}`);
      err.category = 'unexpected_state';
      err.extra = { content: result.content };
      throw err;
    }
    return unwrapResult(result);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse either a bare JSON body or a single-event SSE body (`data: {...}`) —
 *  the two shapes a Streamable HTTP MCP server may reply with for one call. */
function parseJsonRpcBody(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try { return JSON.parse(text); } catch { return null; }
  }
  for (const line of text.split('\n')) {
    const m = /^data:\s*(.+)$/.exec(line.trim());
    if (m) {
      try { return JSON.parse(m[1]); } catch { /* keep scanning */ }
    }
  }
  return null;
}

/** Flatten an MCP CallToolResult to plain data for the CLI's JSON output:
 *  prefer structuredContent when the server provides it; otherwise fall back
 *  to the text of any text-type content blocks (joined), else the raw blocks. */
function unwrapResult(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (texts.length) {
    const joined = texts.map((b) => b.text).join('\n');
    try { return JSON.parse(joined); } catch { return { text: joined }; }
  }
  return { content: blocks };
}

function summarizeContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.join('\n') || '(no message)';
}
