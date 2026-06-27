// Type shim for selector-candidates.mjs (the pure candidate-scoring core).
// Keep in sync with selector-candidates.mjs exports.

export type Candidate = {
  kind: string;
  selector?: string;
  matchCount?: number;
  score?: number;
};

export const KIND_WEIGHT: Record<string, number>;
export function scoreCandidate(c: Candidate): number;
export function rankCandidates(candidates: Candidate[] | null | undefined): Candidate[];
export function bestCandidate(candidates: Candidate[] | null | undefined): Candidate | null;
export function cssEscapeIdent(s: unknown): string;
