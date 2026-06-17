#!/usr/bin/env node
// ─── SPIKE (spike/playwright-cdp): in-app browser automation helper ──────────
//
// A tiny CLI an in-app Claude Code agent invokes (via Bash) to drive Breeze's
// EMBEDDED browser tab over CDP, using playwright-core. This is the Playwright
// analog of the `--chrome` (Claude-in-Chrome) integration: instead of a Chrome
// extension operating an external Chrome, the agent drives the WebContentsView
// living inside a Breeze 'browser' tab.
//
// It LAUNCHES NOTHING — `connectOverCDP` attaches to the Chromium already
// running inside Breeze (electron/main.ts exposes --remote-debugging-port).
// playwright-core ships no browser binaries; we reuse Electron's Chromium.
//
// Resolution:
//   CDP endpoint  ← $BREEZE_CDP_URL        (default http://localhost:9222)
//   target page   ← first attached page that is NOT the Breeze renderer or
//                   DevTools; override/disambiguate with $BREEZE_BROWSER_TARGET
//                   (a substring matched against the page URL or title).
//
// Usage:  node cli.mjs <verb> [args...]
//   open [url]                  open a NEW Breeze browser tab (via the control
//                               API) and wait for it to attach; then drive it
//   pages                       list attachable pages (debug)
//   url                         print the embedded tab's current URL
//   title                       print the page title
//   goto <url>                  navigate the tab
//   snapshot [selector]         ARIA snapshot (the agent's "eyes"; default body)
//   text [selector]            innerText of selector (default body)
//   click <selector>            click first match (css, text=, xpath=)
//   fill <selector> <value>     clear + type into an input
//   type <selector> <value>     type into an element (no clear)
//   press <key>                 keyboard press (e.g. Enter, Control+a)
//   wait <selector>             wait for selector to attach
//   eval <jsExpression>         page.evaluate a JS expression, print JSON result
//   screenshot [path] [full]    PNG of the tab (default ./browser-shot.png in
//                               the cwd, viewport; `full` = whole page)
//
// Output goes to stdout (plain text or JSON); errors to stderr with exit 1.
// The process always detaches cleanly (browser.close() drops the CDP client;
// it does NOT close Breeze or the tab).

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CDP = process.env.BREEZE_CDP_URL || 'http://localhost:9222';
const TARGET = (process.env.BREEZE_BROWSER_TARGET || '').trim();
// Breeze's localhost control API: ~/.breezefile/api.json holds {port, token}.
const API_FILE = path.join(os.homedir(), '.breezefile', 'api.json');

function fail(msg) {
  process.stderr.write(String(msg) + '\n');
  process.exit(1);
}

// Ask Breeze to OPEN an embedded browser tab (the helper can't create one over
// CDP — Electron refuses CDP target creation). Goes through the same localhost
// /app/* control API the `breeze` CLI uses, authed with the api.json token.
async function openBrowserTab(url) {
  let api;
  try {
    api = JSON.parse(readFileSync(API_FILE, 'utf8'));
  } catch {
    fail(`cannot read ${API_FILE} — is Breeze running?`);
  }
  const res = await fetch(`http://127.0.0.1:${api.port}/app/open-browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${api.token}` },
    body: JSON.stringify(url ? { url } : {}),
  }).catch((e) => fail(`open-browser request failed: ${e.message}`));
  if (!res.ok) fail(`open-browser returned ${res.status}: ${await res.text()}`);
}

// Is this one of Breeze's OWN pages (the React renderer or DevTools) rather
// than the user-facing embedded browser tab? We never want to drive those.
function isOwnPage(url) {
  if (!url) return true;
  if (url.startsWith('devtools://')) return true;
  // Renderer in dev: http://localhost:<vite-port>/. In a packaged build it's a
  // file:// URL ending in index.html.
  if (/^https?:\/\/localhost:\d+\/?($|#|\?)/.test(url)) return true;
  if (url.startsWith('file://') && /index\.html/.test(url)) return true;
  return false;
}

// Find the embedded browser-tab page. Retries briefly: when the agent acts the
// instant its session boots, the tab's WebContentsView may still be attaching.
async function resolvePage(browser) {
  const deadline = Date.now() + 10_000;
  let lastSeen = [];
  for (;;) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    lastSeen = pages.map((p) => p.url());
    let candidates = pages.filter((p) => !isOwnPage(p.url()));
    if (TARGET) {
      const hits = [];
      for (const p of candidates) {
        const u = p.url();
        let t = '';
        try { t = await p.title(); } catch { /* page gone */ }
        if (u.includes(TARGET) || t.includes(TARGET)) hits.push(p);
      }
      candidates = hits;
    }
    if (candidates.length) return candidates[candidates.length - 1];
    if (Date.now() > deadline) {
      fail(
        `no embedded browser tab found over CDP at ${CDP}.\n` +
          `Open a Breeze browser tab (Ctrl/Cmd+B) first.\n` +
          (TARGET ? `(filtering by BREEZE_BROWSER_TARGET="${TARGET}")\n` : '') +
          `pages seen: ${JSON.stringify(lastSeen)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Playwright treats a bare string selector as CSS but also understands engine
// prefixes (text=, xpath=, role=…). `.first()` keeps strict-mode happy when a
// selector matches several nodes.
function loc(page, selector) {
  return page.locator(selector).first();
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb) fail('usage: cli.mjs <verb> [args...]  (try: pages | snapshot | goto <url>)');

  // `open` reaches Breeze BEFORE attaching over CDP: ask it to create the tab,
  // then attach + wait for the new page to show up.
  if (verb === 'open') {
    await openBrowserTab(rest[0]);
  }

  const browser = await chromium.connectOverCDP(CDP);
  try {
    if (verb === 'open') {
      const page = await resolvePage(browser);
      process.stdout.write(`opened browser tab: ${page.url()}\n`);
      return;
    }
    // `pages` is the one verb that inspects all targets, not a single tab.
    if (verb === 'pages') {
      const pages = browser.contexts().flatMap((c) => c.pages());
      const rows = [];
      for (const p of pages) {
        let t = '';
        try { t = await p.title(); } catch { /* ignore */ }
        rows.push({ url: p.url(), title: t, own: isOwnPage(p.url()) });
      }
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }

    const page = await resolvePage(browser);

    switch (verb) {
      case 'url':
        process.stdout.write(page.url() + '\n');
        break;
      case 'title':
        process.stdout.write((await page.title()) + '\n');
        break;
      case 'goto': {
        const url = rest[0];
        if (!url) fail('goto needs a url');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        process.stdout.write(`navigated to ${page.url()}\n`);
        break;
      }
      case 'snapshot': {
        const sel = rest[0] || 'body';
        process.stdout.write((await loc(page, sel).ariaSnapshot()) + '\n');
        break;
      }
      case 'text': {
        const sel = rest[0] || 'body';
        process.stdout.write((await loc(page, sel).innerText()) + '\n');
        break;
      }
      case 'click': {
        const sel = rest[0];
        if (!sel) fail('click needs a selector');
        await loc(page, sel).click();
        process.stdout.write(`clicked ${sel}\n`);
        break;
      }
      case 'fill': {
        const [sel, ...v] = rest;
        if (!sel) fail('fill needs a selector and value');
        await loc(page, sel).fill(v.join(' '));
        process.stdout.write(`filled ${sel}\n`);
        break;
      }
      case 'type': {
        const [sel, ...v] = rest;
        if (!sel) fail('type needs a selector and value');
        await loc(page, sel).pressSequentially(v.join(' '));
        process.stdout.write(`typed into ${sel}\n`);
        break;
      }
      case 'press': {
        const key = rest[0];
        if (!key) fail('press needs a key (e.g. Enter)');
        await page.keyboard.press(key);
        process.stdout.write(`pressed ${key}\n`);
        break;
      }
      case 'wait': {
        const sel = rest[0];
        if (!sel) fail('wait needs a selector');
        await loc(page, sel).waitFor();
        process.stdout.write(`visible: ${sel}\n`);
        break;
      }
      case 'eval': {
        const expr = rest.join(' ');
        if (!expr) fail('eval needs a JS expression');
        // Playwright evaluates a string as a JS expression in the page's main
        // world. Wrap so both `1+1` and `() => …` / async forms work.
        const result = await page.evaluate(`(async () => (${expr}))()`);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }
      case 'screenshot': {
        // `screenshot [path] [full]` — default to a stable, predictable path so
        // the agent can Read the PNG to SEE the tab. Viewport by default (what's
        // on screen); pass `full` for the whole scrollable page.
        const full = rest.includes('full');
        // Default into the CALLER's cwd (the agent's session dir, which is
        // --add-dir'd) so the agent can Read the PNG back without a prompt.
        const out =
          rest.find((a) => a !== 'full') || path.join(process.cwd(), 'browser-shot.png');
        await page.screenshot({ path: out, fullPage: full });
        process.stdout.write(out + '\n');
        break;
      }
      default:
        fail(`unknown verb: ${verb}`);
    }
  } finally {
    // Detach the CDP client. Does NOT close Breeze or the tab.
    await browser.close().catch(() => {});
  }
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
