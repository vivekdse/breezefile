// Type shim for memory.mjs (durable NON-PHI site/task notes the browser agent
// accumulates). Keep in sync with memory.mjs exports.

export type MemoryScope = 'site' | 'task';
export type MemoryEntry = { text: string; at: string | null };
export type Memory = { scope: string; key: string; entries: MemoryEntry[] };

export function memoryDir(): string;
export function siteKey(urlOrHost: string): string;
export function getMemory(scope: MemoryScope, key: string): Memory;
export function addMemory(
  scope: MemoryScope,
  key: string,
  text: string,
  opts?: { at?: string },
): { ok: boolean; scope: string; key: string; count: number };
export function deleteMemory(
  scope: MemoryScope,
  key: string,
  opts?: { index?: number | boolean | null },
): { ok: boolean; removed?: string; count?: number; error?: string };
export function listMemory(): {
  site: Array<{ key: string; count: number }>;
  task: Array<{ key: string; count: number }>;
};
