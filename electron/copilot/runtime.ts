// task-8676ddafadf0 — CopilotKit runtime, main-process only.
//
// Starts a localhost-only (127.0.0.1) HTTP server exposing a CopilotRuntime
// backed by the Anthropic adapter (model: claude-haiku-4-5-20251001). This is
// the CopilotKit "foundation" — a persistent sidebar action surface, NOT a
// PHI-carrying task chat. Do not route task bodies through this endpoint
// without re-reading the PHI rules in CLAUDE.md.
//
// API key resolution mirrors electron/llm.ts's pattern (env wins, then a
// small on-disk settings file) without importing that module — llm.ts's
// key store (userData/llm.json) is a *separate* metadata-only surface owned
// by fm-2ln/fm-5rk, and this module is scoped to NEW electron/copilot/*
// files only. We read the same file read-only as a convenience so a user who
// has already configured a key for the tag-NL feature gets Copilot for free;
// we never write it here. If neither source has a key, the server simply
// does not start — `getCopilotInfo()` reports `{ enabled: false }` and the
// renderer degrades to a one-line setup hint.
//
// NEVER log the resolved key or chat message bodies — only lifecycle events
// (start/stop/port) may be logged.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { CopilotRuntime, AnthropicAdapter, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime';
import Anthropic from '@anthropic-ai/sdk';

const COPILOT_MODEL = 'claude-haiku-4-5-20251001';
const ENDPOINT = '/copilotkit';

export type CopilotInfo = { enabled: boolean; port?: number; endpoint?: string };

let server: http.Server | null = null;
let info: CopilotInfo = { enabled: false };

// Same on-disk shape as electron/llm.ts's settings file: { anthropicApiKey }.
// Read-only reference here — this module never writes it.
function llmSettingsPath(): string {
  return path.join(app.getPath('userData'), 'llm.json');
}

async function resolveApiKey(): Promise<string | null> {
  const env = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (env) return env;
  try {
    const raw = await fs.readFile(llmSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const k = typeof parsed?.anthropicApiKey === 'string' ? parsed.anthropicApiKey.trim() : '';
    return k || null;
  } catch {
    return null;
  }
}

/** Start the CopilotKit runtime server if an API key is available. Idempotent. */
export async function startCopilotRuntime(): Promise<CopilotInfo> {
  if (server) return info;

  const key = await resolveApiKey();
  if (!key) {
    info = { enabled: false };
    return info;
  }

  const runtime = new CopilotRuntime();
  const serviceAdapter = new AnthropicAdapter({
    anthropic: new Anthropic({ apiKey: key }),
    model: COPILOT_MODEL,
  });
  const handler = copilotRuntimeNodeHttpEndpoint({
    endpoint: ENDPOINT,
    runtime,
    serviceAdapter,
  });

  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // CORS: the renderer is a different origin (http://localhost:5173 in
      // dev, file://-derived `null` when packaged), so the CopilotKit
      // client's JSON POST preflights. Reflect ONLY local origins — this
      // server holds an LLM key, and a permissive `*` would let any webpage
      // in the user's browser drive it via 127.0.0.1.
      const origin = req.headers.origin;
      const localOrigin =
        !!origin && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'null');
      if (localOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] || 'Content-Type',
        );
      }
      if (req.method === 'OPTIONS') {
        res.statusCode = localOrigin ? 204 : 403;
        res.end();
        return;
      }
      // Fire-and-forget: the handler streams the GraphQL response itself.
      // Never log req bodies (chat content) here.
      void handler(req, res);
    });
    srv.on('error', (err) => {
      console.error('[copilot] runtime server error:', (err as Error).message);
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      server = srv;
      info = { enabled: true, port, endpoint: ENDPOINT };
      console.log(`[copilot] runtime listening on 127.0.0.1:${port}${ENDPOINT}`);
      resolve(info);
    });
  });
}

export function stopCopilotRuntime(): void {
  if (server) {
    server.close();
    server = null;
  }
  info = { enabled: false };
}

// Mirrors electron/api-server.ts's own quit-hook idiom: the module owns its
// lifecycle rather than main.ts reaching in to stop it.
app.on('before-quit', stopCopilotRuntime);

/** Current status — used by the copilot:info IPC handler. */
export function getCopilotInfo(): CopilotInfo {
  return info;
}
