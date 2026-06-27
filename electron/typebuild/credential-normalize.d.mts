// Type surface for credential-normalize.mjs (plain ESM, no Electron).

export interface SavedCredentialShape {
  origin: string;
  username: string;
  updatedAt?: string;
}

export function normalizeCredentialList(body: unknown): SavedCredentialShape[];
