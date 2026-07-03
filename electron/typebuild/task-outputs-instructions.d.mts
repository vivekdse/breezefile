// Type surface for task-outputs-instructions.mjs (plain ESM, no Electron).

export type TaskOutputFieldType = 'text' | 'number' | 'date' | 'select' | 'bool';

export interface TaskOutputFieldLike {
  key: string;
  label: string;
  type: TaskOutputFieldType;
  options?: string[];
  required?: boolean;
}

export interface ParsedTaskOutputsBlock {
  taskDefId: string;
  fields: TaskOutputFieldLike[];
}

export function parseTaskOutputsBlock(body: unknown): ParsedTaskOutputsBlock | null;

export function renderTaskOutputsInstructions(body: unknown): string;
