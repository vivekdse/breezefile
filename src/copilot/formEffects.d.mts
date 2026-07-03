// task-ae0ec0348930 — type surface for the pure formEffects.mjs reducer (runtime
// is formEffects.mjs; this is the type view src/copilot/formExtensions.ts imports).

/** The allowlisted effects run-logic returns (at most these four keys). */
export type FormEffects = {
  setValue?: Record<string, unknown>;
  setVisible?: Record<string, boolean>;
  setOptions?: Record<string, string[]>;
  validate?: Record<string, string | null>;
};

/** Per-field interpreter state the reducer maintains. */
export type InterpreterState = {
  hidden: Record<string, boolean>;
  options: Record<string, string[]>;
  errors: Record<string, string>;
};

/** Minimal shape resolveApplicableExtension matches against. */
export type ExtensionMatchable = {
  status: string;
  appliesTo: Record<string, unknown>;
  projectId: string | null;
};

export const EFFECT_KEYS: readonly string[];
export function emptyInterpreterState(): InterpreterState;
export function sanitizeEffects(raw: unknown): FormEffects;
export function applyEffectsToState(
  state: InterpreterState,
  effects: FormEffects,
): InterpreterState;
export function valueWritesFromEffects(effects: FormEffects): Record<string, string>;
export function resolveApplicableExtension<T extends ExtensionMatchable>(
  extensions: T[],
  templateKey: string | null | undefined,
  projectId: string | null | undefined,
): T | null;
