// task-b8fa34a80a34 — type surface for the pure rosterGroups.mjs module (runtime
// is plain ESM so `node --test` imports it without a transpile step). Mirrors
// the pipelineRoster.d.mts convention.

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'bool';

export type OutputField = {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
};

/** One task fed to the grouper — DEFINITIONS + METADATA only, never values. */
export type RosterGroupInput = {
  id: string;
  title?: string | null;
  projectId?: string | null;
  /** Forward-compatible: exact template grouping when the server ships it. */
  templateId?: string | null;
  templateName?: string | null;
  dataKeys?: string[] | null;
  outputSchema?: OutputField[] | null;
  status?: string;
  createdAt?: number | null;
};

export type InputCol = {
  key: string;
  label: string;
  type: FieldType;
  io: 'in';
  required: false;
};

export type OutputCol = {
  key: string;
  label: string;
  type: FieldType;
  io: 'out';
  required: boolean;
  options?: string[];
};

export type GroupRow = { taskId: string; instanceId: string; status: string | undefined };

export type RosterGroup = {
  key: string;
  name: string;
  inputCols: InputCol[];
  outputCols: OutputCol[];
  rows: GroupRow[];
};

export type OtherRow = { taskId: string; title: string; status: string | undefined };

export type RosterGroups = { groups: RosterGroup[]; other: OtherRow[] };

export type StatusBucket = 'done' | 'progress' | 'queued' | 'needs' | 'failed' | 'cancelled';

export type GroupSummary = {
  runCount: number;
  statusCounts: Record<StatusBucket, number>;
  assignees: string[];
};

export const STATUS_BUCKETS: StatusBucket[];
export function statusBucket(status: string | undefined | null): StatusBucket;
export function summarizeGroupRows(
  runs: { status?: string; assignee?: string | null }[],
): GroupSummary;

export function isFieldBearing(task: RosterGroupInput): boolean;
export function groupNameFor(task: RosterGroupInput): string;
export function groupKeyFor(task: RosterGroupInput): string;
export function deriveInstanceId(task: RosterGroupInput, groupName: string, index: number): string;
export function buildRosterGroups(tasks: RosterGroupInput[]): RosterGroups;
