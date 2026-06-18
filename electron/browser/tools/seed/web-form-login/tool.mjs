// web-form-login — fill a standard username/password form and submit.
//
// Generalized per docs/Playwright agent.md: instead of a per-site login tool,
// one parameterized tool that finds the fields via accessibility-first
// heuristics (the doc's selector-stability priority: aria/role/semantic over
// brittle ids). Site-specific selectors are accepted as overrides for the cases
// the heuristics miss.
//
//   params = { url?, username, password, success?, *_selector? }

// Find the first visible element matching any of a list of candidate locators.
async function firstVisible(page, candidates) {
  for (const make of candidates) {
    const locp = make();
    try {
      const n = await locp.count();
      for (let i = 0; i < n; i++) {
        const el = locp.nth(i);
        if (await el.isVisible()) return el;
      }
    } catch { /* selector engine rejected it — skip */ }
  }
  return null;
}

export async function run(ctx, params) {
  const { page, log, ToolError } = ctx;

  if (!params.username || !params.password) {
    throw new ToolError('precondition_not_met', 'username and password are required');
  }

  if (params.url) {
    log.step(`navigating to ${params.url}`);
    await page.goto(params.url, { waitUntil: 'domcontentloaded' });
  }

  // ── username field ──
  log.step('locating username field');
  const userField = params.user_selector
    ? page.locator(params.user_selector).first()
    : await firstVisible(page, [
        () => page.locator('input[autocomplete="username"]'),
        () => page.locator('input[type="email"]'),
        () => page.getByLabel(/email|username|user name|login/i),
        () => page.locator('input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]'),
      ]);
  if (!userField) {
    throw new ToolError('selector_not_found', 'could not find a username/email field', {
      action: 'pass --user_selector',
    });
  }
  await userField.fill(params.username);
  log.ok('username entered');

  // ── password field ──
  log.step('locating password field');
  const passField = params.pass_selector
    ? page.locator(params.pass_selector).first()
    : await firstVisible(page, [
        () => page.locator('input[type="password"]'),
        () => page.locator('input[autocomplete="current-password"]'),
        () => page.getByLabel(/password/i),
      ]);
  if (!passField) {
    // Some flows reveal the password field only after the username is submitted.
    throw new ToolError('selector_not_found', 'could not find a password field (multi-step login? pass --pass_selector or run again)', {
      action: 'pass --pass_selector',
    });
  }
  await passField.fill(params.password);
  log.ok('password entered');

  // ── submit ──
  log.step('submitting');
  const submit = params.submit_selector
    ? page.locator(params.submit_selector).first()
    : await firstVisible(page, [
        () => page.getByRole('button', { name: /log ?in|sign ?in|continue|submit/i }),
        () => page.locator('button[type="submit"], input[type="submit"]'),
      ]);
  if (submit) {
    await submit.click();
  } else {
    // No obvious button — pressing Enter in the password field submits most forms.
    await passField.press('Enter');
  }

  // Let navigation / SPA auth settle.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // ── confirm ──
  const warnings = [];
  let logged_in = false;
  if (params.success) {
    log.step(`confirming via success check: ${params.success}`);
    try {
      await page.locator(params.success).first().waitFor({ state: 'visible', timeout: 10_000 });
      logged_in = true;
    } catch {
      // Distinguish "still on a password screen" (likely wrong creds / MFA)
      // from "logged in but success selector is wrong".
      const stillHasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
      if (stillHasPassword) {
        throw new ToolError('auth_failed', 'still on a login form after submit — wrong credentials or an MFA/verification step', {
          final_url: page.url(),
        });
      }
      throw new ToolError('validation_failed', `submitted, but the --success selector never appeared: ${params.success}`, {
        final_url: page.url(),
      });
    }
  } else {
    // No explicit check: infer from the password field being gone.
    const stillHasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    logged_in = !stillHasPassword;
    if (logged_in) {
      warnings.push('success inferred from the password field disappearing (no --success given). Pass --success for a reliable check.');
    } else {
      throw new ToolError('auth_failed', 'password field still present after submit — login likely failed (wrong credentials or MFA)', {
        final_url: page.url(),
      });
    }
  }

  log.ok('logged in');
  return {
    logged_in,
    final_url: page.url(),
    __validation: { username_filled: true, password_filled: true, submitted: true, logged_in },
    __warnings: warnings,
    __suggestions: params.success
      ? []
      : ['Provide --success (e.g. "text=Sign out") so future runs confirm login deterministically.'],
  };
}
