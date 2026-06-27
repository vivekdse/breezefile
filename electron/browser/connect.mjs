// Shared CDP connect + page-resolution for Breeze browser automation.
//
// Extracted from electron/browser/cli.mjs so the verb CLI (cli.mjs) AND the
// tool runner (bin/breeze-tools.mjs) resolve the embedded browser page the
// EXACT same way. One source of truth: if the way Breeze's own pages are
// identified ever changes, it changes here and both surfaces follow.
//
// Like cli.mjs, this LAUNCHES NOTHING — connectOverCDP attaches to the
// Chromium already running inside Breeze (electron/main.ts exposes
// --remote-debugging-port). playwright-core ships no browser binaries.

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

/** CDP endpoint Breeze exposes. Override with $BREEZE_CDP_URL. */
export const CDP_URL = process.env.BREEZE_CDP_URL || 'http://localhost:9222';

/** Breeze's localhost control API handshake: ~/.breezefile/api.json holds
 *  {port, token, pid}. Written by electron/api-server.ts on startup. */
export const API_FILE = path.join(os.homedir(), '.breezefile', 'api.json');

/** Read the api.json handshake. Returns null (never throws) when Breeze isn't
 *  running so callers can produce their own actionable error. */
export function readApi() {
  try {
    return JSON.parse(readFileSync(API_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Ask Breeze to OPEN an embedded browser tab. The helper can't create one
 *  over CDP (Electron refuses CDP target creation), so this goes through the
 *  same localhost /app/* control API the `breeze` CLI uses, authed with the
 *  api.json token. Throws on failure with an actionable message. */
export async function openBrowserTab(url) {
  const api = readApi();
  if (!api) throw new Error(`cannot read ${API_FILE} — is Breeze running?`);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${api.port}/app/open-browser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${api.token}` },
      body: JSON.stringify(url ? { url } : {}),
    });
  } catch (e) {
    throw new Error(`open-browser request failed: ${e.message}`);
  }
  if (!res.ok) throw new Error(`open-browser returned ${res.status}: ${await res.text()}`);
}

/** Is this one of Breeze's OWN pages (the React renderer or DevTools) rather
 *  than the user-facing embedded browser tab? We never drive those. */
export function isOwnPage(url) {
  if (!url) return true;
  if (url.startsWith('devtools://')) return true;
  // Renderer in dev: http://localhost:<vite-port>/. Packaged: a file:// URL
  // ending in index.html.
  if (/^https?:\/\/localhost:\d+\/?($|#|\?)/.test(url)) return true;
  if (url.startsWith('file://') && /index\.html/.test(url)) return true;
  return false;
}

/** Connect to Breeze's Chromium over CDP. Detach with `browser.close()` —
 *  that drops the CDP client only; it does NOT close Breeze or the tab. */
export async function connect(cdpUrl = CDP_URL) {
  return chromium.connectOverCDP(cdpUrl);
}

/** Find the embedded browser-tab page. Retries briefly: when an agent acts the
 *  instant its session boots, the tab's WebContentsView may still be attaching.
 *
 *  @param browser   a connected playwright Browser
 *  @param opts.target   substring matched against page url OR title to
 *                       disambiguate when several non-own pages exist
 *  @param opts.timeoutMs how long to keep retrying (default 10s)
 *  @param opts.cdpUrl   only used to make the not-found error actionable */
export async function resolvePage(browser, opts = {}) {
  const target = (opts.target ?? process.env.BREEZE_BROWSER_TARGET ?? '').trim();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const cdpUrl = opts.cdpUrl ?? CDP_URL;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  for (;;) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    lastSeen = pages.map((p) => p.url());
    let candidates = pages.filter((p) => !isOwnPage(p.url()));
    if (target) {
      const hits = [];
      for (const p of candidates) {
        const u = p.url();
        let t = '';
        try { t = await p.title(); } catch { /* page gone */ }
        if (u.includes(target) || t.includes(target)) hits.push(p);
      }
      candidates = hits;
    }
    if (candidates.length) return candidates[candidates.length - 1];
    if (Date.now() > deadline) {
      throw new Error(
        `no Breeze browser window found over CDP at ${cdpUrl}.\n` +
          `Run \`open\` first to create it.\n` +
          (target ? `(filtering by target="${target}")\n` : '') +
          `pages seen: ${JSON.stringify(lastSeen)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** List all attachable pages (debug helper). */
export async function listPages(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  const rows = [];
  for (const p of pages) {
    let t = '';
    try { t = await p.title(); } catch { /* ignore */ }
    rows.push({ url: p.url(), title: t, own: isOwnPage(p.url()) });
  }
  return rows;
}

/** Playwright treats a bare string as CSS but also understands engine prefixes
 *  (text=, xpath=, role=…). `.first()` keeps strict-mode happy. */
export function loc(page, selector) {
  return page.locator(selector).first();
}

// ─── Record-mode time-share (teach-by-recording) ─────────────────────────────
//
// CRITICAL CONSTRAINT: CDP allows exactly ONE debugger client per target. The
// teach recorder attaches Electron's built-in webContents.debugger to read the
// accessibility tree (role + accessible name). That COLLIDES with Playwright's
// connectOverCDP — only one can hold the page's CDP at a time. So we TIME-SHARE:
// during RECORD mode the HUMAN drives (not the agent), so we drop Playwright's
// CDP client, let the recorder use the debugger, and on finish reconnect
// Playwright for replay. NEVER run both at once.
//
// These helpers make that explicit and symmetric. They operate on a Playwright
// Browser handle (from connect()); the recorder's debugger.attach lives in MAIN
// (electron/browser/record.ts), this side only releases/reacquires Playwright.

/** Release Playwright's CDP client so the recorder's webContents.debugger can
 *  attach without colliding. Closing the Browser drops only the CDP connection;
 *  it does NOT close Breeze or the embedded tab (same as elsewhere in this
 *  file). Returns true if a live browser was released. Never throws. */
export async function releaseForRecording(browser) {
  if (!browser) return false;
  try {
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/** Reacquire a Playwright CDP client after recording finishes (the recorder has
 *  detached its debugger). Returns a fresh connected Browser, or null if Breeze
 *  isn't reachable. Caller then resolvePage()s again to drive replay. */
export async function reconnectAfterRecording(cdpUrl = CDP_URL) {
  try {
    return await connect(cdpUrl);
  } catch {
    return null;
  }
}
