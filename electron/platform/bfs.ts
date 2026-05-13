import { promises as fs } from 'node:fs';
import path from 'node:path';

// Shared BFS name-walker. Used by LinuxAdapter to substitute for an OS
// metadata index, and available to any other adapter that wants a portable
// fallback. Token matching mirrors the renderer-side rules in ipc.ts:
// per-token AND; short tokens (≤3) require a word boundary.

export type BfsOptions = {
  roots: string[];
  tokens: string[];
  limit: number;
  maxDepth?: number;
  skipSegments?: ReadonlySet<string>;
  dirsOnly?: boolean;
};

const DEFAULT_SKIP = new Set([
  '.git', 'node_modules', '__pycache__', '.cache', '.venv', 'venv',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.svn', '.hg',
  '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup',
  'dist', 'build', 'target', '.next', '.nuxt', 'out',
  'snap', '.local',
]);

function tokenMatches(lname: string, oname: string, tokens: string[]): boolean {
  for (const t of tokens) {
    if (t.length <= 3) {
      let from = 0;
      let found = false;
      while (from <= lname.length - t.length) {
        const i = lname.indexOf(t, from);
        if (i < 0) break;
        const before = i === 0 ? '' : lname[i - 1];
        const after = i + t.length >= lname.length ? '' : lname[i + t.length];
        const isWordChar = (ch: string) => /[a-z0-9]/.test(ch);
        const beforeOk = !before || !isWordChar(before)
          || (oname[i - 1] && oname[i] && oname[i - 1] === oname[i - 1].toLowerCase() && oname[i] !== oname[i].toLowerCase());
        const afterOk = !after || !isWordChar(after)
          || (oname[i + t.length - 1] && oname[i + t.length] && oname[i + t.length - 1] === oname[i + t.length - 1].toLowerCase() && oname[i + t.length] !== oname[i + t.length].toLowerCase());
        if (beforeOk && afterOk) { found = true; break; }
        from = i + 1;
      }
      if (!found) return false;
    } else {
      if (!lname.includes(t)) return false;
    }
  }
  return true;
}

export async function bfsSearch(opts: BfsOptions): Promise<string[]> {
  if (opts.tokens.length === 0) return [];
  const skip = opts.skipSegments ?? DEFAULT_SKIP;
  const maxDepth = opts.maxDepth ?? 8;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const root of opts.roots) {
    let frontier: string[] = [root];
    for (let level = 0; level <= maxDepth && frontier.length > 0 && out.length < opts.limit; level++) {
      const results = await Promise.all(
        frontier.map(async (dir) => {
          try {
            const ents = await fs.readdir(dir, { withFileTypes: true });
            const subdirs: string[] = [];
            const hits: string[] = [];
            for (const ent of ents) {
              if (skip.has(ent.name)) continue;
              const full = path.join(dir, ent.name);
              const isDir = ent.isDirectory();
              if (opts.dirsOnly && !isDir) continue;
              const lname = ent.name.toLowerCase();
              if (tokenMatches(lname, ent.name, opts.tokens)) hits.push(full);
              if (isDir && !ent.name.startsWith('.')) subdirs.push(full);
            }
            return { hits, subdirs };
          } catch {
            return { hits: [] as string[], subdirs: [] as string[] };
          }
        }),
      );
      const next: string[] = [];
      outer: for (const r of results) {
        for (const h of r.hits) {
          if (seen.has(h)) continue;
          seen.add(h);
          out.push(h);
          if (out.length >= opts.limit) break outer;
        }
        for (const s of r.subdirs) next.push(s);
      }
      frontier = next;
      if (out.length >= opts.limit) break;
    }
    if (out.length >= opts.limit) break;
  }
  return out;
}
