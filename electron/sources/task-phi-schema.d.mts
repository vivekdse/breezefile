// task-fe9e4c4cda44 — type surface for the shared PHI-store schema module
// (task-phi-schema.mjs is plain ESM so the on-disk test can import it without a
// transpile step; the store imports the DDL + migration list).

/** Ordered column set of the encrypted task_phi table (title/body ARE PHI). */
export const PHI_COLUMNS: string[];

/** Enumerated vocab for the sync_state / origin columns. */
export const SYNC_STATES: string[];
export const ORIGINS: string[];

/** CREATE TABLE DDL for task_phi (kept in lockstep with PHI_COLUMNS). */
export const PHI_TABLE_SQL: string;

/** Additive migration specs for a legacy (id/title/body-only) task_phi. */
export const PHI_MIGRATION_COLUMNS: Array<{ name: string; spec: string }>;

/** CREATE TABLE DDL for the CLASS-1 task-data value cache (task-780730a010a2). */
export const DATA_CACHE_TABLE_SQL: string;

/** CREATE TABLE DDL for the CLASS-2 vault field value cache. */
export const VAULT_CACHE_TABLE_SQL: string;

/** Parse the column names out of a CREATE TABLE statement. */
export function parsePhiColumnNames(createTableSql: string): string[];
