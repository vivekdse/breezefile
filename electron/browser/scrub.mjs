// Value-leak scrubber for the PII placeholder-fill path (cli.mjs fill-ref /
// type-ref). Extracted into its own module so it is unit-testable without
// running cli.mjs's main(). See docs/pii-data-injection-design.md.
//
// Two leaks to close on a failed fill/type AFTER the value is resolved:
//   1. Playwright appends a "Call log:" block that interpolates the literal
//      typed value, e.g.  fill("123-45-6789").
//   2. The value could otherwise appear anywhere in the message.
// We redact the known value everywhere, drop the call-log block, and keep only
// the first (bounded) line — so a routine selector timeout never spills the
// resolved value into the agent's context via stderr.
export function scrubError(err, secret) {
  let msg = String(err?.message ?? err ?? '');
  if (secret) msg = msg.split(secret).join('<redacted>');
  msg = msg.split('\nCall log:')[0];
  return msg.split('\n')[0].slice(0, 200);
}
