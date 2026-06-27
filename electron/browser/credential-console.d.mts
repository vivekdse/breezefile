// Type surface for credential-console.mjs (runtime is plain ESM, no Electron).

/** Extract the message text from a 'console-message' event's post-Event args,
 *  tolerating both the positional (level, message, ...) and the object-details
 *  ({ message, ... }) listener signatures. Returns '' when none found. */
export function consoleMessageText(...args: unknown[]): string;

/** Return the trailing nonce iff `text` is `${sentinel}:${nonce}`, else null. */
export function matchSentinelNonce(text: string, sentinel: string): string | null;
