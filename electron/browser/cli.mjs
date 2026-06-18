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
//   open [url]                  open/focus the Breeze browser window (via the
//                               control API), wait for it, then drive it
//   pages                       list attachable pages (debug)
//   url                         print the browser window's current URL
//   title                       print the page title
//   goto <url>                  navigate the tab
//   snapshot [selector]         ARIA snapshot (the agent's "eyes"; default body)
//   text [selector]            innerText of selector (default body)
//   click <selector>            click first match (css, text=, xpath=)
//   fill <selector> <value>     clear + type into an input
//   type <selector> <value>     type into an element (no clear)
//   fill-ref <selector> <ref>   clear + fill with a TypeBuild task `data` value
//                               resolved by ref — the literal value never enters
//                               this command's argv/stdout or the agent's context
//   type-ref <selector> <ref>   type a `data` value resolved by ref (no clear)
//   press <key>                 keyboard press (e.g. Enter, Control+a)
//   wait <selector>             wait for selector to attach
//   eval <jsExpression>         page.evaluate a JS expression, print JSON result
//   screenshot [path] [full]    PNG of the tab (default ./browser-shot.png in
//                               the cwd, viewport; `full` = whole page)
//
// Output goes to stdout (plain text or JSON); errors to stderr with exit 1.
// The process always detaches cleanly (browser.close() drops the CDP client;
// it does NOT close Breeze or the tab).

import path from 'node:path';
import {
  CDP_URL as CDP,
  connect,
  openBrowserTab,
  resolvePage,
  listPages,
  loc,
  readApi,
  API_FILE,
} from './connect.mjs';

function fail(msg) {
  process.stderr.write(String(msg) + '\n');
  process.exit(1);
}

// Resolve a placeholder ref (a TypeBuild task `data` key, e.g. "patient.ssn")
// to its real value via Breeze MAIN. Main fetches + decrypts the value and
// returns it over the localhost control API; it lands in THIS helper process
// only — it never appears in the agent's argv, stdout, or context. The task id
// comes from $BREEZE_TYPEBUILD_TASK_ID (injected for TypeBuild sessions). See
// docs/pii-data-injection-design.md. We never print the resolved value.
async function resolveDataRef(ref) {
  const taskId = (process.env.BREEZE_TYPEBUILD_TASK_ID || '').trim();
  if (!taskId) {
    fail('fill-ref/type-ref require $BREEZE_TYPEBUILD_TASK_ID (TypeBuild sessions only)');
  }
  const api = readApi();
  if (!api) fail(`cannot read ${API_FILE} — is Breeze running?`);
  const res = await fetch(
    `http://127.0.0.1:${api.port}/app/task-data` +
      `?taskId=${encodeURIComponent(taskId)}&ref=${encodeURIComponent(ref)}`,
    { headers: { authorization: `Bearer ${api.token}` } },
  ).catch((e) => fail(`task-data request failed: ${e.message}`));
  // The error envelope from main carries only the opaque ref key, never a value.
  if (!res.ok) fail(`could not resolve ref "${ref}" (${res.status}): ${await res.text()}`);
  const body = await res.json().catch(() => ({}));
  if (typeof body.value !== 'string') fail(`ref "${ref}" returned no value`);
  return body.value;
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb) fail('usage: cli.mjs <verb> [args...]  (try: pages | snapshot | goto <url>)');

  // `open` reaches Breeze BEFORE attaching over CDP: ask it to create the tab,
  // then attach + wait for the new page to show up.
  if (verb === 'open') {
    await openBrowserTab(rest[0]).catch((e) => fail(e.message));
  }

  const browser = await connect(CDP);
  try {
    if (verb === 'open') {
      const page = await resolvePage(browser);
      process.stdout.write(`opened browser window: ${page.url()}\n`);
      return;
    }
    // `pages` is the one verb that inspects all targets, not a single tab.
    if (verb === 'pages') {
      process.stdout.write(JSON.stringify(await listPages(browser), null, 2) + '\n');
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
      case 'fill-ref': {
        const [sel, ref] = rest;
        if (!sel || !ref) fail('fill-ref needs a selector and a data ref');
        const value = await resolveDataRef(ref);
        await loc(page, sel).fill(value);
        // Print the OPAQUE ref, never the value.
        process.stdout.write(`filled ${sel} (ref ${ref})\n`);
        break;
      }
      case 'type-ref': {
        const [sel, ref] = rest;
        if (!sel || !ref) fail('type-ref needs a selector and a data ref');
        const value = await resolveDataRef(ref);
        await loc(page, sel).pressSequentially(value);
        process.stdout.write(`typed into ${sel} (ref ${ref})\n`);
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
