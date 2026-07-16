// Type surface for task-outputs-instructions.mjs (plain ESM, no Electron).
//
// task-1425579c1194 — parseTaskOutputsBlock is re-exported from the
// renderer's src/components/newhome/taskSchema.mjs (the single owner of
// every task-body fenced-block parser); re-export its type here too instead
// of maintaining a parallel shape.

export type { ParsedTaskOutputs as ParsedTaskOutputsBlock } from '../../src/components/newhome/taskSchema';

export { parseTaskOutputsBlock } from '../../src/components/newhome/taskSchema';

export function renderTaskOutputsInstructions(body: unknown): string;
