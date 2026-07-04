// Type declarations for taskDataInputs.mjs (mirrors taskAnswer.d.mts).

export function normalizeDataKey(raw: unknown): string;
export function isValidDataKey(raw: unknown): boolean;
export function looksSensitive(key: unknown): boolean;
export function effectiveDataKeys(
  dataKeys: string[] | undefined,
  sessionKnownKeys: string[] | undefined,
): string[];

export function canEditTaskData(args: {
  claimedBy?: string | null;
  createdBy?: string | null;
  viewerEmail?: string | null;
}): boolean;

export function dataAuthDeniedMessage(kind: 'read' | 'write'): string;

export type DataPatchPayload = { upsert: Record<string, string>; delete: string[] };

export function buildDataPatchPayload(args: {
  drafts: Record<string, string>;
  originals: Record<string, string>;
  removedKeys: string[];
}): DataPatchPayload;

export function hasPendingDataChanges(payload: DataPatchPayload | null | undefined): boolean;

export function siblingKeysForPatch(
  allKnownKeys: string[] | undefined,
  payload: DataPatchPayload | null | undefined,
): string[];
