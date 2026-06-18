// Type shim for install-runtime.mjs (the .mjs stays out of the tsc graph;
// main.ts imports it dynamically). Keep in sync with install-runtime.mjs exports.

export function automationDir(): string;
export function installAutomation(): {
  dir: string;
  installed: string[];
  errors: string[];
};
