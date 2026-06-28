// gmail-prefill-send — compose Gmail via the prefill URL.
//
// The "efficient approach" from docs/Playwright agent.md: rather than click
// Compose → fill To → fill Subject → fill Body (5+ UI round-trips), navigate
// straight to Gmail's compose-mode URL with the fields encoded as query params.
// Gmail opens the compose window already populated.
//
//   ctx = { page, log, loc, EXIT, ToolError, state, ... }   (from breeze-tools run())
//   params = { to, subject?, body?, cc?, bcc?, send? }
//
// RESUMABLE STEPS (Operator Speed). This tool is expressed as ORDERED, NAMED
// steps instead of one opaque `run` (see docs/resumable-tool-steps.md):
//
//   compose  — idempotent: navigate to the prefill URL + confirm the compose
//              window rendered. Safe to re-run; re-running just re-opens compose.
//   send     — SIDE-EFFECT: clicks Send, which irreversibly dispatches the mail.
//              The runner records this step ONLY after it completes, and on a
//              later resume planResume() REFUSES to re-run it — so a partial
//              break can never double-send. The `pre` hook is the human-gate:
//              Send is only attempted when --send was explicitly passed.
//
// The exported `steps` array is authoritative; tool.json also DECLARES the same
// names + sideEffect marks so `help`/discovery can show the plan without import.
// `state` carries the (NON-PHI) located Send button between steps.

/** Step 1 — compose: open Gmail's compose-mode URL prefilled. Idempotent. */
async function compose(ctx, params) {
  const { page, log, ToolError, state } = ctx;

  if (!params.to) throw new ToolError('precondition_not_met', 'missing recipient (--to)');

  // Build Gmail's compose-mode URL. view=cm opens compose; fs=1 makes it
  // full-screen so fields/Send are reliably present.
  const qs = new URLSearchParams({ view: 'cm', fs: '1', to: params.to });
  if (params.subject) qs.set('su', params.subject);
  if (params.body) qs.set('body', params.body);
  if (params.cc) qs.set('cc', params.cc);
  if (params.bcc) qs.set('bcc', params.bcc);
  const url = `https://mail.google.com/mail/?${qs.toString()}`;

  log.step('navigating to Gmail compose (prefill URL)');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // If Gmail bounced us to the sign-in flow, we're not authenticated.
  if (/accounts\.google\.com/.test(page.url())) {
    throw new ToolError('auth_failed', 'not signed in to Gmail (redirected to accounts.google.com)');
  }

  // The Send button is the most reliable signal the compose window rendered.
  // aria-label='Send' is stable across redesigns (it's accessibility-tied).
  const sendBtn = page.getByRole('button', { name: /^Send\b/ }).first();
  try {
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new ToolError('selector_not_found', 'compose window did not appear (Send button not visible)', {
      selector_attempted: 'role=button[name=/^Send/]',
      action: 'find_new_selector',
    });
  }
  log.ok('compose window open and prefilled');
  // Stash NOTHING PHI; we re-locate the button in `send` (locators don't survive
  // a process; this just flags compose succeeded).
  state.composed = true;
  return {
    composed: true,
    sent: false,
    to: params.to,
    __validation: { compose_opened: true, prefilled: true, sent: false },
  };
}

/** Pre-gate for the side-effecting send step: only attempt Send when the human
 *  explicitly passed --send. Returning false aborts BEFORE Send fires, leaving
 *  the draft open for review (the human-gated-submit rule). */
function sendGate(ctx, params) {
  if (!params.send) {
    ctx.log.ok('draft left open for review (no --send) — not sending');
    return false;
  }
  return true;
}

/** Step 2 — send: SIDE-EFFECT. Clicks Send (irreversible). Guarded by sendGate
 *  so it never fires without --send, and recorded-as-done so resume never
 *  re-fires it. */
async function send(ctx, params) {
  const { page, log, ToolError } = ctx;
  const sendBtn = page.getByRole('button', { name: /^Send\b/ }).first();
  log.step('clicking Send');
  try {
    await sendBtn.click();
    // Gmail shows a "Message sent" toast and closes the compose window.
    await page.waitForTimeout(500);
    log.ok('Send clicked');
  } catch (e) {
    throw new ToolError('element_disabled', `Send failed: ${e.message}`);
  }
  return {
    composed: true,
    sent: true,
    to: params.to,
    __validation: { compose_opened: true, prefilled: true, sent: true },
    __warnings: [],
    __suggestions: [],
  };
}

export const steps = [
  { name: 'compose', sideEffect: false, run: compose },
  { name: 'send', sideEffect: true, pre: sendGate, run: send },
];

// Back-compat shim: a single `run` that drives the steps in order. Kept so any
// caller still importing `run` directly (outside the breeze-tools runner) keeps
// working. The runner itself uses `steps` and ignores this. When --send is
// absent the send step's gate no-ops, matching the old draft-only behavior.
export async function run(ctx, params) {
  const state = ctx.state || (ctx.state = {});
  let result = await compose(ctx, params);
  if (sendGate(ctx, params)) {
    result = await send(ctx, params);
  } else {
    result = {
      ...result,
      __warnings: ['draft left open for review (no --send). Pass --send to send it.'],
      __suggestions: ['Add --send to send automatically once you trust the draft.'],
    };
  }
  return result;
}
