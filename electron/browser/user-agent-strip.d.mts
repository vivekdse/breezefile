// Type surface for user-agent-strip.mjs (runtime is plain ESM, no Electron).

export function stripElectronTokens(ua: string, appProduct?: string): string;

export function cleanChromeUserAgent(
  runtimeUa: string,
  appProduct?: string,
  chromeVersion?: string,
): string;
