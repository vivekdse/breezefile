// fm-2ln / fm-5rk — main-process, metadata-only LLM helper for the tag frontend.
//
// The renderer asks the LLM to compile a natural-language tag description into a
// tagDsl selector (+ name + color), and to refine that selector from rejected
// examples. This module is the ONLY place the Anthropic API key is read or used
// — it stays in main, never crosses to the renderer. The renderer reaches it
// through the `llm:*` IPC registered here; it passes a fully-built prompt
// payload (system + messages, assembled by the pure src/tagCompose.mjs) and
// gets back raw model text, which the renderer then validates (again, via
// tagCompose.parseLlmResponse) before showing a preview.
//
// In-process call (NOT the CLI-PTY chat surface): a single `fetch` to the
// Anthropic Messages API. We deliberately avoid adding the @anthropic-ai/sdk
// dependency — one metadata-only request doesn't justify it, and `fetch` is
// global in Electron 33's Node. Model IDs are confirmed: Haiku 4.5
// (claude-haiku-4-5) for the cheap first pass, Sonnet 4.6 (claude-sonnet-4-6)
// as the refine/escalation model — the renderer chooses which via the payload.
//
// Graceful degradation: if no API key is configured, `llm:available` reports
// false and the renderer disables the NL box with a "set API key" hint. We
// never hard-fail.
//
// NON-PHI: only file METADATA (names/sizes/dates) reaches the model, and only
// what the renderer already shaped. The API key is never logged.

import { ipcMain, app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface LlmPayload {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}

// The key can come from the environment OR a small settings file in userData
// (llm.json: { "anthropicApiKey": "sk-ant-..." }). Env wins. The settings file
// lets a user configure the key without exporting it into the launch env.
function settingsPath(): string {
  return path.join(app.getPath('userData'), 'llm.json');
}

let cachedFileKey: string | null | undefined; // undefined = not yet read

async function readFileKey(): Promise<string | null> {
  if (cachedFileKey !== undefined) return cachedFileKey ?? null;
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const k =
      typeof parsed?.anthropicApiKey === 'string' ? parsed.anthropicApiKey.trim() : '';
    cachedFileKey = k || null;
  } catch {
    cachedFileKey = null;
  }
  return cachedFileKey ?? null;
}

/** Resolve the API key (env first, then the userData settings file). */
async function resolveKey(): Promise<string | null> {
  const env = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (env) return env;
  return readFileKey();
}

/**
 * Run one metadata-only Messages-API request and return the model's text.
 * Throws on transport / API errors (the renderer surfaces a friendly message).
 * The API key is read here and never returned or logged.
 */
async function runMessages(payload: LlmPayload): Promise<string> {
  const key = await resolveKey();
  if (!key) {
    const err: Error & { code?: string } = new Error('no-api-key');
    err.code = 'no-api-key';
    throw err;
  }
  const body = {
    model: payload.model,
    max_tokens: payload.maxTokens ?? 1024,
    system: payload.system,
    messages: payload.messages,
  };
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`network error contacting the model: ${(e as Error).message}`);
  }
  if (!res.ok) {
    // Read the error body for a useful message, but never echo the key.
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j?.error?.message ? `: ${j.error.message}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`model request failed (HTTP ${res.status})${detail}`);
  }
  const json: unknown = await res.json();
  // content is an array of blocks; concatenate the text blocks.
  const blocks =
    (json as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('model returned an empty response');
  return text;
}

/** Register the `llm:*` IPC. Call once from registerIpc(). */
export function registerLlmIpc(): void {
  // Is the metadata-only LLM frontend usable? (key present). The renderer gates
  // the NL box on this. NON-PHI, returns only a boolean.
  ipcMain.handle('llm:available', async (): Promise<boolean> => {
    const key = await resolveKey();
    return !!key;
  });

  // Run a prebuilt prompt payload. The renderer assembles the payload with the
  // pure tagCompose helpers and validates the returned text itself.
  ipcMain.handle(
    'llm:run',
    async (_e, payload: LlmPayload): Promise<{ ok: true; text: string } | { ok: false; code?: string; error: string }> => {
      try {
        const text = await runMessages(payload);
        return { ok: true, text };
      } catch (e) {
        const err = e as Error & { code?: string };
        return { ok: false, code: err.code, error: err.message };
      }
    },
  );

  // Invalidate the cached file key (e.g. after the user writes llm.json).
  ipcMain.handle('llm:reloadKey', async (): Promise<boolean> => {
    cachedFileKey = undefined;
    const key = await resolveKey();
    return !!key;
  });

  // Set (or, with an empty string, clear) the userData/llm.json key, then
  // reload the in-memory cache. Lets the Settings UI configure the key without
  // exporting it into the launch env. SECURITY: the key value is written to the
  // settings file and NEVER logged or echoed back — we return only a boolean
  // reporting whether a key is now resolvable (env still wins over the file).
  ipcMain.handle('llm:setKey', async (_e, key: unknown): Promise<boolean> => {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    const file = settingsPath();
    try {
      if (trimmed) {
        await fs.writeFile(
          file,
          JSON.stringify({ anthropicApiKey: trimmed }, null, 2),
          { mode: 0o600 },
        );
      } else {
        // Clear: drop the key. Remove the file entirely so no empty secret
        // lingers on disk. Missing file is fine.
        await fs.rm(file, { force: true });
      }
    } catch {
      // Surface as "not available" rather than throwing the (possibly
      // path-revealing) fs error across the bridge.
      cachedFileKey = undefined;
      return !!(await resolveKey());
    }
    cachedFileKey = undefined;
    return !!(await resolveKey());
  });
}
