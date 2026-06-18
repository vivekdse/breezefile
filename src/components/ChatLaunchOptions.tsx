// fm — inline-chat launch options picker.
//
// When the user opens an agent chat inline (folder header 💬, edit-mode 💬,
// or the :chat verb — all route through App's `fm:toggle-chat` handler), this
// lightweight overlay surfaces a couple of fast launch toggles before the
// agent spawns. The canonical ones are Claude Code's `--continue` (resume the
// most recent conversation) and `--dangerously-skip-permissions`.
//
// The toggles are agent-specific: each option declares the flag it adds and
// the function `claudeChatOptions()` builds the Claude-only set. For agents we
// don't recognise the caller passes an empty option list and the overlay
// degrades to a plain "Start chat" confirm. The chosen flags come back as a
// flat string[] the caller threads into the spawn command line.

import { useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import './ChatLaunchOptions.css';

export type ChatLaunchOption = {
  /** Stable key for React + the toggle id. */
  id: string;
  label: string;
  hint?: string;
  /** CLI flag(s) appended to the launch command when this option is on. */
  flags: string[];
  /** Initial checked state (default off — fresh session). */
  defaultOn?: boolean;
};

/** Claude Code's inline-chat launch toggles. Returns [] for any agent that
 *  isn't Claude so the picker degrades to a bare "Start chat" confirm. The
 *  caller detects Claude by command/id (see isClaudeAgent in openChat.ts). */
export function claudeChatOptions(): ChatLaunchOption[] {
  return [
    {
      id: 'continue',
      label: 'Continue previous session',
      hint: 'Resume the most recent conversation (--continue)',
      flags: ['--continue'],
    },
    {
      id: 'skip-perms',
      label: 'Skip permissions',
      hint: 'Run without permission prompts (--dangerously-skip-permissions)',
      flags: ['--dangerously-skip-permissions'],
    },
  ];
}

export function ChatLaunchOptions({
  agentLabel,
  targetLabel,
  options,
  onClose,
  onStart,
}: {
  /** The resolved agent's label, e.g. "Claude Code". */
  agentLabel: string;
  /** Short label for what the chat is anchored to (folder / file name). */
  targetLabel: string;
  /** Toggles to offer; empty → no toggles, just a Start confirm. */
  options: ChatLaunchOption[];
  onClose: () => void;
  /** Receives the union of flags from the enabled options (deduped, in order). */
  onStart: (flags: string[]) => void;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const [on, setOn] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const o of options) init[o.id] = !!o.defaultOn;
    return init;
  });

  const start = () => {
    const flags: string[] = [];
    const seen = new Set<string>();
    for (const o of options) {
      if (!on[o.id]) continue;
      for (const f of o.flags) {
        if (!seen.has(f)) {
          seen.add(f);
          flags.push(f);
        }
      }
    }
    onStart(flags);
  };

  return (
    <div
      className="overlay"
      data-state={state}
      onClick={exit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          start();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          exit();
        }
      }}
    >
      <div
        className="overlay__box chatlaunch"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="overlay__label">Start chat · {agentLabel}</div>
        <div className="chatlaunch__target" title={targetLabel}>
          {targetLabel}
        </div>

        {options.length > 0 ? (
          <div className="chatlaunch__opts">
            {options.map((o) => (
              <label key={o.id} className="chatlaunch__opt">
                <input
                  type="checkbox"
                  checked={!!on[o.id]}
                  onChange={(e) =>
                    setOn((prev) => ({ ...prev, [o.id]: e.target.checked }))
                  }
                />
                <span className="chatlaunch__opt-text">
                  <span className="chatlaunch__opt-label">{o.label}</span>
                  {o.hint && (
                    <span className="chatlaunch__opt-hint">{o.hint}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="chatlaunch__none">
            Start a fresh chat session in this location.
          </div>
        )}

        <div className="chatlaunch__actions">
          <button
            type="button"
            className="chatlaunch__btn chatlaunch__btn--cancel"
            onClick={exit}
          >
            Cancel <span className="chatlaunch__kbd">Esc</span>
          </button>
          <button
            type="button"
            className="chatlaunch__btn chatlaunch__btn--primary"
            autoFocus
            onClick={start}
          >
            Start chat <span className="chatlaunch__kbd">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
