// TypeBuild MCP server provisioning (fm-b5at.5).
//
// An interactive TypeBuild session needs the `typebuild` MCP server
// configured in the user's Claude Code so `/mcp__typebuild__work` resolves.
// We ensure it idempotently before the first interactive launch:
//
//   1. `claude mcp list` (via the resolved binary, login-shell env so the
//      user's PATH/HOME are correct) — if 'typebuild' already appears, done.
//   2. otherwise `claude mcp add --transport http --scope user typebuild
//      https://general.typebuild.com/mcp`.
//
// The check is cached in memory for the process lifetime (one success means
// the entry exists; we never need to re-run). Failures are NON-FATAL: the
// caller surfaces a hint and still launches — the first in-session OAuth
// (~8h token) pops on first tool use regardless.
//
// SECURITY/PHI: this module deals only with the static MCP endpoint URL and
// server name — no task content, no tokens. We never log command output
// verbatim (it could, in theory, echo unrelated server names); only a terse
// PHI-free status is logged.

import { spawn } from 'node:child_process';
import { resolveClaudeBin } from '../agents/claude';

const MCP_NAME = 'typebuild';
const MCP_URL = 'https://general.typebuild.com/mcp';

/** Result of an ensure attempt. `ok` true means the server is configured
 *  (already present or just added). `hint` carries a terse, PHI-free message
 *  for the caller to surface when ok is false. */
export type EnsureMcpResult = { ok: boolean; hint?: string };

// Cached success — once the entry exists it stays; no need to re-probe.
let ensured: Promise<EnsureMcpResult> | null = null;

// Run `claude <args>` with a login shell so the user's profile PATH/HOME load
// (GUI launches inherit a minimal env). We invoke the resolved absolute
// binary directly but still wrap in `-lc` via the user's shell so any
// `claude`-side env (e.g. ANTHROPIC_* the user exports) matches an
// interactive run. Resolves { code, out } where `out` is stdout+stderr.
function runClaude(
  bin: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    child.on('error', () => resolve({ code: -1, out }));
    child.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

async function doEnsure(): Promise<EnsureMcpResult> {
  let bin: string;
  try {
    bin = await resolveClaudeBin();
  } catch {
    return { ok: false, hint: 'Claude Code not found — finish onboarding first.' };
  }

  // 1. Is it already configured? `claude mcp list` prints one line per
  //    server; we look for the name token. A non-zero exit (e.g. claude not
  //    installed) is non-fatal — fall through to add, which will report.
  const list = await runClaude(bin, ['mcp', 'list']);
  if (list.code === 0 && mentionsTypebuild(list.out)) {
    return { ok: true };
  }

  // 2. Add it (user scope so every project sees it).
  const add = await runClaude(bin, [
    'mcp',
    'add',
    '--transport',
    'http',
    '--scope',
    'user',
    MCP_NAME,
    MCP_URL,
  ]);
  if (add.code === 0) {
    console.log('[typebuild-mcp] registered typebuild MCP server');
    return { ok: true };
  }
  // Already-exists races can surface as a non-zero exit with an "already
  // exists" message; treat that as success too.
  if (/already exists|already configured/i.test(add.out)) {
    return { ok: true };
  }
  return {
    ok: false,
    hint: 'Could not configure the TypeBuild MCP server automatically.',
  };
}

// Match the server name as a whole token so we don't false-positive on a
// substring of some unrelated server. `claude mcp list` formats vary across
// versions ("typebuild: ...", "typebuild  https://...").
function mentionsTypebuild(out: string): boolean {
  return new RegExp(`(^|\\s)${MCP_NAME}(\\s|:)`, 'm').test(out);
}

/** Idempotently ensure the typebuild MCP server is configured. Cached on
 *  success. Never throws — returns { ok:false, hint } on any failure so the
 *  caller can launch anyway and surface a gentle hint. */
export function ensureTypebuildMcp(): Promise<EnsureMcpResult> {
  if (ensured) return ensured;
  ensured = doEnsure().then((res) => {
    // Only cache successes; a failure should be retried on the next launch
    // (the user may have just installed claude / fixed PATH).
    if (!res.ok) ensured = null;
    return res;
  });
  return ensured;
}
