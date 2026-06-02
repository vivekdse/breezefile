// fm-dly3 — open an agent chat in the right-docked panel.
//
// "Chat" is an agent CLI (Claude Code / Gemini CLI / …) running in a PTY
// anchored to the current folder (folder tabs) or the open document's dir
// (edit tabs). We reuse the launchers config to pick which agent and the
// existing terminal-spawn plumbing; the agent boots in `cwd` and we pre-type
// a context preamble (no trailing Enter — the user reviews and sends).

import { fm, type Launcher } from './bridge';
import { resolveCommandLine } from './launchers';
import { spawnTerminal } from './terminalSpawn';
import { basename, dirname } from './actions';
import { formatOpError } from './errorMessages';

export type ChatTarget =
  | { kind: 'folder'; cwd: string }
  | { kind: 'document'; filePath: string };

// Structural subset of the store dispatch — kept local so this module doesn't
// depend on the (unexported) store Action union.
type ChatDispatch = (
  action:
    | {
        type: 'openChat';
        tabIndex: number;
        ptyId: number;
        cwd: string;
        agentId: string;
        label?: string;
      }
    | { type: 'setStatus'; msg: string },
) => void;

/** Resolve the configured agent launcher by id. Returns null when no id is
 *  given or it no longer matches a launcher — the caller then surfaces the
 *  "set a default chat agent" prompt rather than silently guessing. */
async function pickAgent(agentId?: string): Promise<Launcher | null> {
  if (!agentId) return null;
  let list: Launcher[] = [];
  try {
    list = await fm.launchersList();
  } catch {
    return null;
  }
  return list.find((l) => l.id === agentId) ?? null;
}

function preambleFor(target: ChatTarget): string {
  if (target.kind === 'document') {
    return `I'm looking at this file — let's discuss and edit it together: ${target.filePath}\n`;
  }
  return `I'm working in this folder — help me explore and work with its files: ${target.cwd}\n`;
}

export type OpenChatResult = { ok: true } | { ok: false; needsAgent: true };

/** Spawn the configured agent for `target` and dock it as this tab's chat
 *  panel. Returns { ok:false, needsAgent:true } when `agentId` is unset or no
 *  longer resolves, so the caller can surface the default-agent prompt. */
export async function openChatPanel(opts: {
  tabIndex: number;
  target: ChatTarget;
  /** The configured default agent launcher id (fm-9iha). */
  agentId?: string | null;
  dispatch: ChatDispatch;
}): Promise<OpenChatResult> {
  const { tabIndex, target, agentId, dispatch } = opts;
  const cwd = target.kind === 'folder' ? target.cwd : dirname(target.filePath);
  const agent = await pickAgent(agentId ?? undefined);
  if (!agent) return { ok: false, needsAgent: true };
  const { commandLine, label } = resolveCommandLine(agent);
  const name =
    target.kind === 'document' ? basename(target.filePath) : basename(cwd) || cwd;
  try {
    const ptyId = await spawnTerminal({ cwd, sessionLabel: `chat · ${name}` });
    dispatch({ type: 'openChat', tabIndex, ptyId, cwd, agentId: agent.id, label });
    // Boot the agent, then pre-type the context. Cadence mirrors
    // invokeLauncher: 220ms for the shell prompt, then ~900ms for the AI CLI
    // to draw its input box. No trailing \r on the preamble — the user edits
    // and sends it themselves.
    setTimeout(() => fm.termWrite(ptyId, commandLine + '\r'), 220);
    setTimeout(() => fm.termWrite(ptyId, preambleFor(target)), 900);
    dispatch({ type: 'setStatus', msg: `chat · ${label}` });
    return { ok: true };
  } catch (err) {
    dispatch({ type: 'setStatus', msg: formatOpError('chat', err) });
    return { ok: true }; // spawn failed but it's a real attempt, not a missing-agent case
  }
}
