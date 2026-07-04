// Type surface for hooks-register-core.mjs (plain ESM, no Electron).

export interface HookEntry {
  type?: 'command';
  command: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export function isBreezeHook(h: HookEntry): boolean;
export function withoutBreezeMatchers(
  blocks: HookMatcher[] | undefined,
): HookMatcher[];
