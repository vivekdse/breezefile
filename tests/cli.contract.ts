// Compile-time contract test for the breeze CLI.
//
// The CLI is plain ESM (bin/breeze.mjs) and can't import TS types at
// runtime. This file is the bridge: it pulls the canonical Task shape
// from electron/tasks.ts and lists every field the CLI actually reads.
// If anyone renames or removes one of these fields in the canonical
// type, `npm run typecheck` fails — drift surfaces in CI before the
// CLI silently misbehaves.
//
// To keep this test honest: when bin/breeze.mjs starts reading a new
// field, add it to CLI_READ_FIELDS below. tsc enforces every entry is
// `keyof Task`, but it cannot enforce completeness — that part is on
// the human writing the code review.

import type { Task, TaskCreate, TaskUpdate } from '../electron/tasks.ts';

const CLI_READ_FIELDS: ReadonlyArray<keyof Task> = [
  'id',
  'title',
  'notes',
  'status',
  'folder',
];

const CLI_CREATE_FIELDS: ReadonlyArray<keyof TaskCreate> = [
  'title',
  'folder',
  'notes',
];

const CLI_UPDATE_FIELDS: ReadonlyArray<keyof TaskUpdate> = ['status'];

// Reference the arrays so noUnusedLocals doesn't strip them.
export const _contract = {
  read: CLI_READ_FIELDS,
  create: CLI_CREATE_FIELDS,
  update: CLI_UPDATE_FIELDS,
};
