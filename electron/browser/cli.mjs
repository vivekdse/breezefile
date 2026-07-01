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
//   ── NETWORK (the Playwright speed lever — skip the UI, use the page's API) ──
//   net-observe [urlFilter] [--ms n] [--assets]   watch the page's XHR/fetch and
//                               print the API requests seen (NON-PHI metadata:
//                               method/url/status/content-type — NEVER bodies).
//                               Run it, then nudge the page, to learn WHICH
//                               request carries the data — that's the fast path.
//   net-replay <url> [--method M] [--data s] [--header k:v]   re-issue a request
//                               through the page's OWN signed-in context (no DOM,
//                               no re-auth) and print {status,content_type,body}.
//                               GET/HEAD are safe reads; a MUTATING method is a
//                               side effect and is REFUSED unless --allow-mutation
//                               (the human-gated-submit rule — pass it only on a
//                               confirmed submit).
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
  resolveDataRef as resolveDataRefShared,
} from './connect.mjs';
import { scrubError } from './scrub.mjs';
import { observeNetwork, replayRequest } from './net.mjs';
import { apiSpecFromRequest, recordApiSpec, validateApiSpec } from './tools/api-spec.mjs';

function fail(msg) {
  process.stderr.write(String(msg) + '\n');
  process.exit(1);
}

/** Split a verb's `rest` into positional args + --flags. Minimal (the rest of
 *  this CLI is positional); used only by the network verbs which take options.
 *  `--ms 4000` → { ms:'4000' }; `--assets` → { assets:true }; repeated --header
 *  collects into an array. */
function splitFlags(rest) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        if (flags[key] === undefined) flags[key] = next;
        else flags[key] = [].concat(flags[key], next);
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

// Resolve a placeholder ref (a TypeBuild task `data` key, e.g. "patient.ssn")
// to its real value via Breeze MAIN. Main fetches + decrypts the value and
// returns it over the localhost control API; it lands in THIS helper process
// only — it never appears in the agent's argv, stdout, or context. The task id
// comes from $BREEZE_TYPEBUILD_TASK_ID (injected for TypeBuild sessions). See
// docs/pii-data-injection-design.md. We never print the resolved value. The
// resolution itself lives in connect.mjs (resolveDataRef) so the tool runner's
// auto-emitted tools resolve refs the same way; here we adapt its thrown error
// to this CLI's fail() convention.
async function resolveDataRef(ref) {
  try {
    return await resolveDataRefShared(ref);
  } catch (e) {
    fail(e.message || String(e));
  }
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
        // The fill itself is the value-bearing step: a Playwright failure here
        // (selector timeout, non-editable element, …) carries the value in its
        // "Call log:". Scrub before it can reach stderr.
        try {
          await loc(page, sel).fill(value);
        } catch (e) {
          fail(`could not fill ${sel} (ref ${ref}): ${scrubError(e, value)}`);
        }
        // Print the OPAQUE ref, never the value.
        process.stdout.write(`filled ${sel} (ref ${ref})\n`);
        break;
      }
      case 'type-ref': {
        const [sel, ref] = rest;
        if (!sel || !ref) fail('type-ref needs a selector and a data ref');
        const value = await resolveDataRef(ref);
        try {
          await loc(page, sel).pressSequentially(value);
        } catch (e) {
          fail(`could not type into ${sel} (ref ${ref}): ${scrubError(e, value)}`);
        }
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
      case 'net-observe': {
        // Watch the page's XHR/fetch and print the API requests seen (NON-PHI
        // metadata only — method/url/status/content-type, never bodies). The
        // discovery step for the API shortcut: run it, then nudge the page, and
        // read which request actually carries the data.
        const { pos, flags } = splitFlags(rest);
        const filter = pos[0] || '';
        const durationMs = flags.ms && flags.ms !== true ? Number(flags.ms) : 4000;
        const includeAssets = !!flags.assets;
        const result = await observeNetwork(page, { filter, durationMs, includeAssets });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }
      case 'net-replay': {
        // Re-issue a request through the page's OWN signed-in context (no DOM,
        // no re-auth). GET/HEAD are safe reads; a MUTATING method (POST/PUT/…)
        // is a side effect, REFUSED unless --allow-mutation (human-gated-submit).
        // NOTE: --data carries a literal payload, so this verb must NOT be used
        // with raw PHI/credential values — resolve those via fill-ref equivalents
        // in a tool step, not on this argv. Body lands in stdout (this process).
        const { pos, flags } = splitFlags(rest);
        const url = pos[0];
        if (!url) fail('net-replay needs a url (e.g. net-replay https://host/api/x --method GET)');
        const method = flags.method && flags.method !== true ? String(flags.method) : 'GET';
        const headers = {};
        for (const h of [].concat(flags.header ?? [])) {
          if (h === true) continue;
          const idx = String(h).indexOf(':');
          if (idx > 0) headers[String(h).slice(0, idx).trim()] = String(h).slice(idx + 1).trim();
        }
        const data = flags.data && flags.data !== true ? flags.data : undefined;
        try {
          const result = await replayRequest(
            page,
            { method, url, headers: Object.keys(headers).length ? headers : undefined, data },
            { allowMutation: !!flags['allow-mutation'] },
          );
          // AUTO-RECORD the discovered API (Operator Speed, task-8ba139c23d18):
          // a SUCCESSFUL replay just proved this endpoint works, so persist the
          // domain-keyed api-spec note WITHOUT the agent driving raw `memory add`.
          // KEYS ONLY: method + url (→ domain/path) and header NAMES only (never
          // the --data payload, never header VALUES). validateApiSpec is the gate
          // — a value-shaped token is refused before any write. Best-effort: a
          // record miss (offline) must never fail the replay that just succeeded.
          if (result && result.ok) {
            try {
              const spec = apiSpecFromRequest(
                { method, url, header_names: Object.keys(headers) },
                { auth: flags.auth && flags.auth !== true ? String(flags.auth) : undefined },
              );
              if (validateApiSpec(spec).ok) await recordApiSpec(spec);
            } catch { /* advisory — never fail a successful replay over recall memory */ }
          }
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } catch (e) {
          fail(e.message || String(e));
        }
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
