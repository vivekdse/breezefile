// Pure predicate/cleanup core for hooks-register.ts (no Electron, no fs) so it
// is unit-testable without a transpile step (same convention as
// claude-stop-backstop.mjs / credential-normalize.mjs). Split out because
// hooks-register.ts's read/write-settings.json plumbing needs Node fs APIs
// that are easy to exercise directly, but the "which hook entries are OURS"
// decision is the part worth unit-testing in isolation — especially the
// task-8997b15a37d9 self-heal migration below.

// We own any hook entry whose command runs claude-hook.sh — re-register
// replaces them rather than appending so idempotency holds even when we
// evolve the command shape.
//
// task-8997b15a37d9 — ALSO recognize the retired `breeze prime` SessionStart/
// PreCompact hook (`"<bundled-path>/bin/breeze" prime`), even though we no
// longer WRITE it (912264a deleted the breeze CLI + the code that emitted
// this hook). Machines that registered hooks before that removal still carry
// a stale entry pointing at the now-deleted `bin/breeze` binary, which errors
// every session ("bin/breeze: not found") since nothing regenerates it. This
// predicate exists purely so withoutBreezeMatchers can strip it on the next
// registerBreezeHooks() call — a self-healing migration, not a re-add.
export function isBreezeHook(h) {
  if (typeof h?.command !== 'string') return false;
  return h.command.includes('claude-hook.sh') || /\bbreeze\b.*\bprime\b/.test(h.command);
}

// Strip every breeze-owned entry out of one event's hook-matcher blocks.
// Blocks left with no hooks are dropped so a cleaned event never carries a
// dangling `{ hooks: [] }` matcher.
export function withoutBreezeMatchers(blocks) {
  if (!blocks) return [];
  const cleaned = [];
  for (const b of blocks) {
    const kept = (b?.hooks ?? []).filter((h) => !isBreezeHook(h));
    if (kept.length > 0) cleaned.push({ ...b, hooks: kept });
  }
  return cleaned;
}
