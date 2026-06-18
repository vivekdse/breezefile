// gmail-prefill-send — compose Gmail via the prefill URL.
//
// The "efficient approach" from docs/Playwright agent.md: rather than click
// Compose → fill To → fill Subject → fill Body (5+ UI round-trips), navigate
// straight to Gmail's compose-mode URL with the fields encoded as query params.
// Gmail opens the compose window already populated.
//
//   ctx = { page, log, loc, EXIT, ToolError, ... }   (from breeze-tools run())
//   params = { to, subject?, body?, cc?, bcc?, send? }
//
// Return value becomes the tool's `result`. Special keys __validation /
// __warnings / __suggestions are surfaced separately in the run output.

export async function run(ctx, params) {
  const { page, log, loc, ToolError } = ctx;

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
    throw new ToolError('selector_not_found', "compose window did not appear (Send button not visible)", {
      selector_attempted: "role=button[name=/^Send/]",
      action: 'find_new_selector',
    });
  }
  log.ok('compose window open and prefilled');

  const warnings = [];
  const result = { composed: true, sent: false, to: params.to };

  if (params.send) {
    log.step('clicking Send');
    try {
      await sendBtn.click();
      // Gmail shows a "Message sent" toast and closes the compose window.
      await page.waitForTimeout(500);
      result.sent = true;
      log.ok('Send clicked');
    } catch (e) {
      throw new ToolError('element_disabled', `Send failed: ${e.message}`);
    }
  } else {
    warnings.push('draft left open for review (no --send). Pass --send to send it.');
  }

  return {
    ...result,
    __validation: { compose_opened: true, prefilled: true, sent: result.sent },
    __warnings: warnings,
    __suggestions: result.sent
      ? []
      : ['Add --send to send automatically once you trust the draft.'],
  };
}
