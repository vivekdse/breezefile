// TypeBuild MCP session registry (fm-b5at.9, consumed by fm-b5at.10).
//
// Each interactive TypeBuild launch mints a short-lived MCP JWT (see
// mcp-token.ts) and injects it into the spawned claude PTY. The token has a
// finite lifetime (~8h); fm-b5at.10 builds an in-app expiry clock that warns
// before it lapses and offers a one-click relaunch. That clock needs to know,
// per live PTY, WHEN the injected token expires and WHICH task it serves.
//
// This module is that registry: a main-process map ptyId → { expiresAt,
// taskId }. We register on a successful spawn and drop the entry when the PTY
// exits, so the set always reflects live, authenticated TypeBuild sessions.
//
// SECURITY/PHI: we store ONLY the expiry epoch and the opaque task id. The MCP
// token itself NEVER lands here (it lives in the PTY env and nowhere else), and
// the task id is not PHI.

export type TypebuildSession = {
  /** Epoch ms at which the injected MCP token expires. */
  expiresAt: number;
  /** Opaque TypeBuild task id this session serves. Not PHI. */
  taskId: string;
};

const sessions = new Map<number, TypebuildSession>();

/** Record a live session keyed by its PTY id. Overwrites any prior entry for
 *  the same ptyId (ptyIds are unique per spawn, so this is just defensive). */
export function registerSession(ptyId: number, session: TypebuildSession): void {
  sessions.set(ptyId, session);
}

/** Drop a session when its PTY exits. No-op if unknown. */
export function clearSession(ptyId: number): void {
  sessions.delete(ptyId);
}

/** Look up a live session by PTY id, or undefined if none. */
export function getSession(ptyId: number): TypebuildSession | undefined {
  return sessions.get(ptyId);
}

/** Snapshot of all live TypeBuild sessions. The expiry clock (fm-b5at.10)
 *  scans this to find the next token approaching expiry. */
export function listSessions(): Array<{ ptyId: number } & TypebuildSession> {
  return [...sessions.entries()].map(([ptyId, s]) => ({ ptyId, ...s }));
}
