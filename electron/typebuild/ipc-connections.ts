// TypeBuild Connections IPC (task-62a5b4324954). Bridges the TypeBuild
// source's connection REST methods to the renderer. A Connection registers
// an external service (a REST API like QuickBooks, or an MCP server) with a
// SERVER-side credential — the credential never crosses back to this
// machine; every read returns a creds-stripped ConnectionSummary.
//
//   typebuild:connections:list           ()               -> ConnectionSummary[]
//   typebuild:connections:get            (id)             -> ConnectionSummary | null
//   typebuild:connections:register       (input)          -> ConnectionSummary
//   typebuild:connections:update         (id, patch)      -> { ok, connection | reason, status }
//   typebuild:connections:remove         (id)             -> { ok, reason?, status? }
//   typebuild:connections:setCredential  (id, credential) -> { ok, reason?, status? }
//   typebuild:connections:refreshSpec    (id)             -> ConnectionSummary
//   typebuild:connections:lookup     (id, callSpec, params) -> ConnectionLookupRow[]
//
// The server endpoints (/chromeext/connections...) are NOT deployed yet — the
// source degrades gracefully (list/get -> []/null, mutations -> a structured
// { ok:false, reason:'unsupported' }) so this surface is usable before the
// server lands. NON-PHI: connection name/kind/endpoint/scope/spec are service
// metadata, not patient data — the credential VALUE is still never logged.
//
// Registered from electron/main.ts (sibling to registerTypebuildProjectsIpc).
// Idempotent, mirrors ipc-projects.ts's `registered` guard.
//
// This task builds the registry + capture surface only — operator-tool
// mounting and field-binding are separate tasks and are NOT wired here.

import { ipcMain } from 'electron';
import { getTaskSource } from '../sources/registry';
import type {
  CallSpec,
  ConnectionCredential,
  ConnectionLookupRow,
  ConnectionRegisterInput,
  ConnectionSummary,
  TypeBuildTaskSource,
} from '../sources/typebuild';

let registered = false;

function source(): TypeBuildTaskSource {
  const src = getTaskSource('typebuild') as TypeBuildTaskSource | undefined;
  if (!src) {
    throw new Error('typebuild: not signed in (connections unavailable)');
  }
  return src;
}

export function registerTypebuildConnectionsIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'typebuild:connections:list',
    (_e): Promise<ConnectionSummary[]> => source().listConnections(),
  );
  ipcMain.handle(
    'typebuild:connections:get',
    (_e, id: string): Promise<ConnectionSummary | null> => source().getConnection(id),
  );
  ipcMain.handle(
    'typebuild:connections:register',
    (_e, input: ConnectionRegisterInput): Promise<ConnectionSummary> =>
      source().registerConnection(input),
  );
  ipcMain.handle(
    'typebuild:connections:update',
    (
      _e,
      id: string,
      patch: Partial<Omit<ConnectionRegisterInput, 'credential'>>,
    ) => source().updateConnection(id, patch),
  );
  ipcMain.handle(
    'typebuild:connections:remove',
    (_e, id: string) => source().deleteConnection(id),
  );
  ipcMain.handle(
    'typebuild:connections:setCredential',
    (_e, id: string, credential: ConnectionCredential) =>
      source().setConnectionCredential(id, credential),
  );
  ipcMain.handle(
    'typebuild:connections:refreshSpec',
    (_e, id: string): Promise<ConnectionSummary> => source().refreshConnectionSpec(id),
  );
  // task-8f27d842f14d — field-source lookup (docs/connections-design.md
  // §D.2). THIN delegation to the source's lookupConnection, which runs the
  // CallSpec client-direct via the parallel operator-tools task's interpreter
  // (electron/typebuild/connection-exec.ts, task-df205c19d40c).
  ipcMain.handle(
    'typebuild:connections:lookup',
    (
      _e,
      connectionId: string,
      callSpec: CallSpec,
      params: Record<string, string>,
    ): Promise<ConnectionLookupRow[]> => source().lookupConnection(connectionId, callSpec, params),
  );
}
