// fm-mph — single source of truth for launcher invocation.
//
// Two surfaces invoke launchers (TaskShell action cards, ChipPrompt verb).
// Before this module they had drifted: the task-mode card injected task
// context (env + sidecar + pre-typed prompt), the chip-prompt verb didn't.
// This file collapses them into one function so adding a new entry point
// (project dashboard, MCP tool, command palette) doesn't require copying
// the launch flow.

import { fm, type Launcher } from './bridge';
import { buildContextPrompt } from './tasks';
import type { Task } from './types';

const BARE_VARIANT_ID = '__bare__';

export type InvokeLauncherArgs = {
  launcher: Launcher;
  /** Variant id, or '__bare__' / undefined to use base args only. */
  variantId?: string;
  /** When set, treat this as a task-bound launch: env injection,
   *  sidecar write, pre-typed context prompt. Should be the active
   *  task tab's task; folder-tab launches pass null. */
  task?: Task | null;
  cwd: string;
  /** When set, write into this PTY instead of spawning a new one.
   *  Existing PTYs can't have new env vars set retroactively, so the
   *  BREEZE_TASK_ID injection is skipped — but context pre-typing
   *  still works. */
  existingPty?: { ptyId: number };
  /** Callbacks — the caller wires these to its dispatch / overlay flow. */
  onStatus?: (msg: string) => void;
  onPtyOpened?: (info: { ptyId: number; label: string; cwd: string }) => void;
};

/** Resolve the full command line for a launcher + variant. */
export function resolveCommandLine(
  launcher: Launcher,
  variantId?: string,
): { command: string; args: string[]; commandLine: string; label: string } {
  const baseArgs = launcher.args ?? [];
  const isBare = !variantId || variantId === BARE_VARIANT_ID;
  if (isBare) {
    return {
      command: launcher.command,
      args: baseArgs,
      commandLine: [launcher.command, ...baseArgs].join(' '),
      label: launcher.label,
    };
  }
  const v = (launcher.variants ?? []).find((x) => x.id === variantId);
  if (!v) {
    // Unknown variant — fall back to bare and let the user notice.
    return {
      command: launcher.command,
      args: baseArgs,
      commandLine: [launcher.command, ...baseArgs].join(' '),
      label: launcher.label,
    };
  }
  const fullArgs = [...baseArgs, ...(v.args ?? [])];
  return {
    command: launcher.command,
    args: fullArgs,
    commandLine: [launcher.command, ...fullArgs].join(' '),
    label: `${launcher.label} · ${v.label}`,
  };
}

export async function invokeLauncher(args: InvokeLauncherArgs): Promise<void> {
  const { launcher, variantId, task, cwd, existingPty, onStatus, onPtyOpened } = args;
  const { commandLine, label } = resolveCommandLine(launcher, variantId);
  const cmd = commandLine + '\r';

  // Every entry in fm.launchersList() is by design an AI-CLI launcher;
  // the bare-shell case is the separate "Open Terminal" path which
  // doesn't go through invokeLauncher. Defensively treat anything with
  // id 'term' as non-AI in case a future catalog adds one.
  const isAi = launcher.id !== 'term';
  const injectContext = !!task && isAi;
  const contextText = injectContext ? buildContextPrompt(task!) : '';

  // Sidecar drop is fire-and-forget; the agent reads it on demand and
  // a write failure shouldn't block the launch.
  if (injectContext) {
    void fm.tasksWriteActiveSidecar(task!.id).catch(() => {
      /* logged in main */
    });
  }

  if (existingPty) {
    // Reuse the running shell. We can't retro-set env vars, so the agent
    // won't see BREEZE_TASK_ID for this run — but pre-typed context still
    // delivers the task to the conversation.
    fm.termWrite(existingPty.ptyId, cmd);
    if (injectContext && contextText) {
      setTimeout(() => fm.termWrite(existingPty.ptyId, contextText), 700);
    }
    onStatus?.(`running ${label}`);
    return;
  }

  try {
    const env = injectContext
      ? { BREEZE_TASK_ID: task!.id, BREEZE_TASK_FOLDER: task!.folder }
      : undefined;
    const ptyId = await fm.termSpawn({ cwd, env });
    onPtyOpened?.({ ptyId, label, cwd });
    // 220ms post-spawn delay: lets the shell finish printing its prompt
    // / running zsh-prompt-init scripts (starship, p10k) before we type
    // the launcher command. Skipping this races with prompt redraws and
    // the command line lands inside title escapes.
    setTimeout(() => fm.termWrite(ptyId, cmd), 220);
    if (injectContext && contextText) {
      // Wait long enough for the AI CLI to spin up + draw its input
      // box. No trailing \r — the user reviews/edits the pre-typed
      // text and presses Enter themselves.
      setTimeout(() => fm.termWrite(ptyId, contextText), 700);
    }
    onStatus?.(`opened terminal · ${label}`);
  } catch (err) {
    onStatus?.(`${label} failed: ${(err as Error).message}`);
  }
}
