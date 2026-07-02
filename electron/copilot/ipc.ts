// task-8676ddafadf0 — tiny IPC surface for the CopilotKit sidebar.
//
// Exposes only connection metadata (enabled/port/endpoint) to the renderer —
// never the API key, never chat content. The renderer uses this to decide
// whether to mount <CopilotKit runtimeUrl=...> at all.

import { ipcMain } from 'electron';
import { getCopilotInfo, type CopilotInfo } from './runtime';

export function registerCopilotIpc(): void {
  ipcMain.handle('copilot:info', (): CopilotInfo => getCopilotInfo());
}
