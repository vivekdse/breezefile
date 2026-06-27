// Type surface for credential-sanitize.mjs (runtime is plain ESM, no Electron).

export interface CapturedCredentialShape {
  origin: string;
  username: string;
  password: string;
}

export function sanitizeCapturedCredential(
  raw: unknown,
): CapturedCredentialShape | null;
