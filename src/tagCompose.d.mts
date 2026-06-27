// fm-2ln / fm-5rk — type surface for the pure tagCompose.mjs LLM-frontend layer
// (runtime is plain ESM so the node test runner can import it without a
// transpile step). Prompt-building + response-validation only; the network
// round-trip lives in electron/llm.ts (main process).

/** One palette entry (mirrors TAG_PALETTE in src/tags.ts). */
export interface PaletteEntry {
  id: string;
  name: string;
  color: string;
}

/** A metadata-only projection of a file Entry (no path/parent, no content). */
export interface ShapedRow {
  name?: string;
  ext?: string;
  size?: number;
  mtime?: number;
  ctime?: number;
  depth?: number;
  mime?: string;
  is_dir?: boolean;
}

/** A message payload ready to hand to the main-process LLM helper. */
export interface ComposePayload {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** A validated suggestion parsed from the LLM response. */
export interface TagSuggestion {
  /** The validated tagDsl selector string (parse()-checked). */
  selector: string;
  /** Normalized kebab-case tag name. */
  name: string;
  /** A hex color from the supplied palette (undefined if no palette given). */
  color?: string;
  /** The raw semantic color hint the model returned. */
  colorHint: string;
  /** Confidence in [0,1] (0.5 when the model omitted it). */
  confidence: number;
}

export const COMPOSE_MODELS: { cheap: string; refine: string };
export const METADATA_FIELDS: string[];

export function shapeRow(row: unknown): ShapedRow;
export function shapeRows(rows: unknown[], limit?: number): ShapedRow[];

export function buildComposePrompt(
  description: string,
  sampleRows?: ShapedRow[],
  opts?: { model?: string },
): ComposePayload;

export function buildRefinePrompt(
  selector: string,
  rejectedRows?: ShapedRow[],
  opts?: { model?: string; description?: string; keptCount?: number },
): ComposePayload;

export function parseLlmResponse(
  rawText: string,
  opts?: { palette?: PaletteEntry[] },
): TagSuggestion;

export function slugifyName(raw: unknown, max?: number): string;
export function pickColor(hint: string, palette: PaletteEntry[]): string | undefined;
