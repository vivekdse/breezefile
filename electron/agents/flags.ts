// Task flags → claude CLI args (fm-b5at.7).
//
// ONE source of truth mapping the task `flags` vocabulary onto claude
// command-line arguments. Shared by the headless runner
// (electron/agents/claude.ts) and the interactive launcher
// (electron/agents/interactive.ts) so the two run styles stay in sync.
//
// Vocabulary (synchronized with the TypeBuild server-side flags field):
//   chrome       → --chrome              (drive a Claude-in-Chrome session)
//   resume       → --continue            (resume the most recent conversation
//                                          in the cwd — the closest CLI flag to
//                                          "pick up where I left off")
//   auto         → --permission-mode acceptEdits
//                  (permissive: lets unattended edits through; MUST NOT bypass
//                   any human-gated approval — we never emit
//                   --dangerously-skip-permissions here)
//   interactive  → (no arg) selects the embedded-tab run style; consumed by
//                  the dispatcher, not passed to claude
//
// Unknown flags are ignored but returned so callers can warn the user.

/** Flags that select run STYLE rather than producing a CLI arg. */
const STYLE_FLAGS = new Set(['interactive']);

/** Known flag → claude args. Order-independent; the caller decides order. */
const FLAG_ARGS: Record<string, string[]> = {
  chrome: ['--chrome'],
  resume: ['--continue'],
  auto: ['--permission-mode', 'acceptEdits'],
};

export type FlagsToArgs = {
  /** Resolved claude CLI args for the recognized, arg-producing flags. */
  args: string[];
  /** Flags we didn't recognize — callers may surface a warning. */
  unknown: string[];
  /** True when the 'interactive' run-style flag is present. */
  interactive: boolean;
};

/** Map a task's flags onto claude CLI args. Pure; safe to call anywhere. */
export function flagsToArgs(flags: string[] | null | undefined): FlagsToArgs {
  const list = Array.isArray(flags) ? flags : [];
  const args: string[] = [];
  const unknown: string[] = [];
  let interactive = false;
  for (const f of list) {
    if (STYLE_FLAGS.has(f)) {
      if (f === 'interactive') interactive = true;
      continue;
    }
    const mapped = FLAG_ARGS[f];
    if (mapped) args.push(...mapped);
    else unknown.push(f);
  }
  return { args, unknown, interactive };
}

/** Convenience: does this flag set request the interactive run style? */
export function isInteractive(flags: string[] | null | undefined): boolean {
  return Array.isArray(flags) && flags.includes('interactive');
}
