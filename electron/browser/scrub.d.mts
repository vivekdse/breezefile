// Type surface for scrub.mjs (plain ESM, no Electron). See scrub.mjs.

/** Redact `secret` from an error message, drop the Playwright "Call log:" block,
 *  and bound the result to one short line. Tolerates an empty/missing secret. */
export function scrubError(err: unknown, secret: string): string;
