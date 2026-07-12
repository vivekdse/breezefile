// docs/connections-design.md §C/§D.1 — job-start Connection mounting.
//
// At the START of every TypeBuild job (electron/sources/typebuild.ts
// launchSessionInner, the same pre-spawn wave that mints the MCP token and
// resolves project context), this module:
//
//   1. Determines the in-scope Connections for the launching task — every
//      Connection whose `scope` resolves to the task's project, or that
//      project's group (§C step 1).
//   2. Brokers ONE credential per in-scope Connection (§C step 2), holding
//      each resolved value in process MEMORY ONLY — never disk, never logs,
//      never argv. Re-fetched every job; nothing here is cached across
//      launches (§C step 4).
//   3. Splits the result into the two DISTINCT mounting paths (§D.1, "no
//      wrapping one as the other"):
//        kind:'mcp'  -> an MCP_INLINE_CONFIG.mcpServers entry + a per-
//                       Connection PTY env var carrying the token.
//        kind:'rest' -> registered for the declarative REST control-endpoint
//                       (electron/api-server.ts `/app/connection-call`,
//                       electron/typebuild/connection-exec.ts), keyed by
//                       connection id, for the duration of this PTY.
//
// SERVER-NOT-DEPLOYED DEGRADATION (load-bearing): the broker route
// (GET /chromeext/connections/:id/credential) 404s today, and `listConnections`
// itself degrades to [] on any failure. Both are ALREADY best-effort in
// typebuild.ts, so this module needs no extra try/catch around them — a
// launch with zero in-scope Connections (the common case right now) simply
// produces empty mount results and the job proceeds exactly as before this
// feature existed. Nothing here ever throws; a failure to resolve or broker
// ANY single Connection just drops that one Connection from the mount set.

import { randomUUID } from 'node:crypto';
import type { ConnectionCredentialResolved } from '../../src/types';
import type { ConnectionSummary, TypeBuildTaskSource } from '../sources/typebuild';

/** One in-scope, brokered `kind:'mcp'` Connection, ready to fold into
 *  MCP_INLINE_CONFIG.mcpServers. `envVar`/`token` are injected into the PTY
 *  env by the caller — never into the argv-visible config string itself
 *  (mirrors MCP_TOKEN_ENV discipline so /proc/<pid>/cmdline never carries
 *  it). */
export type MountedMcpConnection = {
  connectionId: string;
  name: string;
  endpoint: string;
  /** Per-Connection env var name the mcpServers entry's Authorization header
   *  references via `${envVar}` — unique per connection so multiple mounted
   *  MCP Connections never collide. */
  envVar: string;
  /** The bearer value to inject under `envVar`. Memory only. `null` ONLY for
   *  a first-party tile (§J first_party_mcp), whose envVar names the
   *  ALREADY-injected minted-token var (TYPEBUILD_MCP_TOKEN) — there is no
   *  extra value to inject, so buildMcpEnvEntries skips it. */
  token: string | null;
};

/** One in-scope, brokered `kind:'rest'` Connection, held for the lifetime of
 *  this launch so the control endpoint (§D.1c) can execute a CallSpec
 *  against it without re-brokering mid-job. */
export type MountedRestConnection = {
  connectionId: string;
  name: string;
  endpoint: string;
  cred: ConnectionCredentialResolved | null;
};

export type ConnectionMountPlan = {
  mcp: MountedMcpConnection[];
  rest: MountedRestConnection[];
};

const EMPTY_PLAN: ConnectionMountPlan = { mcp: [], rest: [] };

/** Env var prefix for a per-Connection MCP token, mirroring MCP_TOKEN_ENV
 *  (electron/sources/typebuild.ts). One var per connection id so concurrent
 *  mounted MCP Connections never collide; the id is opaque (conn_<hex>), not
 *  PHI, so it's safe in an env var NAME (never its value logged either way). */
function mcpEnvVarFor(connectionId: string): string {
  const safe = connectionId.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
  return `CONN_${safe}_TOKEN`;
}

/** Determine the in-scope Connections for `task`'s project (and that
 *  project's group, if any), then broker one credential per Connection,
 *  concurrently (mirrors the pre-spawn wave's own per-key concurrent-resolve
 *  pattern in launchSessionInner). Returns the empty plan on any structural
 *  miss (no project, no source, listConnections/getProject failure) — those
 *  are all already best-effort in the underlying source methods. */
export async function resolveConnectionMountPlan(
  source: TypeBuildTaskSource,
  opts: { projectId: string | null },
): Promise<ConnectionMountPlan> {
  if (!opts.projectId) return EMPTY_PLAN;
  const projectId = opts.projectId;

  let groupId: string | null = null;
  try {
    const project = await source.getProject(projectId);
    groupId = project?.groupId ?? null;
  } catch {
    groupId = null;
  }

  // §J first_party_mcp — first-party TypeBuild services (e.g. the Scheduler)
  // ride the CATALOG, not the Connection registry: always connected, no
  // materialized record, no broker. Mount each entry's serviceUrl under the
  // minted-token env var the caller already injects (TYPEBUILD_MCP_TOKEN) —
  // same identity, no extra secret plumbing. Fetched alongside the registry;
  // a catalog failure just yields no first-party mounts.
  const firstPartyPromise = source
    .listConnectionCatalog()
    .then((entries) =>
      entries.filter(
        (e) =>
          e.auth === 'first_party_mcp' &&
          e.kind === 'mcp' &&
          typeof e.serviceUrl === 'string' &&
          !!e.serviceUrl &&
          // Catalog visibility is already caller-scoped server-side; a
          // project/group-scoped entry additionally only mounts into jobs of
          // that project/group (mirrors the registry filter below). Unscoped
          // entries mount everywhere.
          (!e.scope ||
            e.scope.type === 'none' ||
            (e.scope.type === 'project'
              ? e.scope.projectId === projectId
              : e.scope.groupId === groupId)),
      ),
    )
    .catch(() => []);

  let all: ConnectionSummary[];
  try {
    all = await source.listConnections();
  } catch {
    all = [];
  }
  const firstParty = await firstPartyPromise;
  if (!all.length && !firstParty.length) return EMPTY_PLAN;

  const mcp: MountedMcpConnection[] = [];
  const rest: MountedRestConnection[] = [];

  for (const e of firstParty) {
    mcp.push({
      connectionId: e.id,
      name: e.name,
      endpoint: e.serviceUrl as string,
      // The minted-token env var (typebuild.ts MCP_TOKEN_ENV) — already in the
      // PTY env for the `typebuild` MCP entry itself; first-party services
      // accept the same identity, so the mcpServers entry just references it.
      envVar: 'TYPEBUILD_MCP_TOKEN',
      token: null,
    });
  }

  const inScope = all.filter((c) => {
    if (c.status === 'disabled') return false;
    if (c.scope.type === 'project') return c.scope.projectId === projectId;
    return groupId !== null && c.scope.groupId === groupId;
  });
  if (!inScope.length) return { mcp, rest };

  // Broker one credential per in-scope Connection, concurrently. A rejected
  // or null-returning broker call just drops that Connection from the plan —
  // never blocks the others, never gates the spawn (unlike mintMcpToken).
  const settled = await Promise.all(
    inScope.map(async (c) => {
      const cred = await source.resolveConnectionCredential(c.id).catch(() => null);
      return { connection: c, cred };
    }),
  );

  for (const { connection, cred } of settled) {
    if (connection.kind === 'mcp') {
      // An MCP Connection with no brokered credential yet (server not
      // deployed, credential not captured) cannot be mounted — mounting it
      // with an empty Authorization header would just produce a confusing
      // 401 inside the agent's session instead of cleanly not offering the
      // tool. Skip it; the job proceeds without that one Connection.
      if (!cred) continue;
      // An OAuth-authorized MCP Connection (§J catalog Connect flow) resolves
      // to an oauth2 credential — map its accessToken to the mount bearer token
      // so it mounts alongside the mcp_token/bearer shapes.
      const token =
        cred.kind === 'mcp_token'
          ? cred.value
          : cred.kind === 'bearer'
            ? cred.value
            : cred.kind === 'oauth2'
              ? cred.accessToken
              : null;
      if (!token) continue;
      mcp.push({
        connectionId: connection.id,
        name: connection.name,
        endpoint: connection.endpoint,
        envVar: mcpEnvVarFor(connection.id),
        token,
      });
    } else {
      // kind:'rest' — always registered even with cred:null (a Connection
      // registered but not yet credentialed still exists as a tool; the
      // executor will surface the upstream 401 rather than the mount
      // silently vanishing, which is more legible for a REST Connection
      // whose creds are optional/public in principle).
      rest.push({
        connectionId: connection.id,
        name: connection.name,
        endpoint: connection.endpoint,
        cred,
      });
    }
  }
  return { mcp, rest };
}

/** Build the extra MCP_INLINE_CONFIG.mcpServers entries for the mounted MCP
 *  Connections (§D.1) — merged into the existing map by the caller so the
 *  `typebuild` entry is untouched. */
export function buildMcpServerEntries(
  mounted: MountedMcpConnection[],
): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  const out: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> = {};
  for (const m of mounted) {
    out[`conn_${m.connectionId}`] = {
      type: 'http',
      url: m.endpoint,
      headers: { Authorization: `Bearer \${${m.envVar}}` },
    };
  }
  return out;
}

/** Build the PTY env entries for the mounted MCP Connections' tokens — env
 *  only, never argv (mirrors MCP_TOKEN_ENV). */
export function buildMcpEnvEntries(mounted: MountedMcpConnection[]): Record<string, string> {
  const out: Record<string, string> = {};
  // token:null = first-party tile riding the already-injected minted-token
  // var — nothing extra to inject (and never overwrite that var here).
  for (const m of mounted) if (m.token !== null) out[m.envVar] = m.token;
  return out;
}

// ─── REST-connection registry (per-PTY, in-memory, for the control endpoint) ──
// The control endpoint (electron/api-server.ts `/app/connection-call`) needs
// to look up a mounted REST Connection's brokered credential by (ptyId,
// connectionId) when the agent's helper CLI calls it — WITHOUT re-brokering
// (§C: one broker call per job, not per tool invocation) and WITHOUT writing
// the credential anywhere outside this process's heap. Keyed by an opaque
// session token (not the ptyId itself, so a leaked ptyId alone can't be used
// to enumerate mounts) that is handed to the spawned process via env,
// mirroring BREEZE_TYPEBUILD_TASK_ID.

const sessionMounts = new Map<string, MountedRestConnection[]>();

/** Register this launch's mounted REST Connections under a fresh opaque
 *  session token, returned for the caller to inject into the PTY env
 *  (BREEZE_CONNECTIONS_SESSION). Call `clearConnectionSession` on PTY exit —
 *  mirrors the clearSession/clearSessionTokens lifecycle pattern already used
 *  for the MCP token and the localhost API token. */
export function registerConnectionSession(rest: MountedRestConnection[]): string {
  const token = randomUUID();
  sessionMounts.set(token, rest);
  return token;
}

export function clearConnectionSession(sessionToken: string): void {
  sessionMounts.delete(sessionToken);
}

/** Look up one mounted REST Connection by session token + connection id. */
export function lookupMountedRestConnection(
  sessionToken: string,
  connectionId: string,
): MountedRestConnection | null {
  const list = sessionMounts.get(sessionToken);
  if (!list) return null;
  return list.find((c) => c.connectionId === connectionId) ?? null;
}

/** List the REST Connections mounted for a session (id + name + endpoint
 *  only — never the credential) — lets the agent's helper CLI discover what
 *  it can call without a server round-trip. */
export function listMountedRestConnections(
  sessionToken: string,
): Array<{ connectionId: string; name: string; endpoint: string }> {
  const list = sessionMounts.get(sessionToken);
  if (!list) return [];
  return list.map((c) => ({ connectionId: c.connectionId, name: c.name, endpoint: c.endpoint }));
}
