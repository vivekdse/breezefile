// Type shim for install.mjs (the .mjs stays out of the tsc graph; main.ts
// imports it dynamically). Keep in sync with install.mjs exports.

export function toolsDir(): string;
export function seedDir(): string;
export function installSeedTools(): { installed: string[]; errors: string[] };
