# Browser field-layer verbs (operator CLI)

The JAWS-style form reader/writer in `electron/browser/cli.mjs`. An agent (or you,
from a shell) perceives a page as one merged accessibility tree — iframes
included — and acts on fields by **ref**, never by hand-written selectors.

From a plain shell on the dev box, prefix every call with the profile + CDP env:

```bash
export BREEZE_PROFILE=dev BREEZE_CDP_URL=http://127.0.0.1:9223
node electron/browser/cli.mjs <verb> [args...]
```

(Operator sessions inherit these; only plain shells need them. `open [url]`
first if no browser window exists.)

## The loop: orient → enumerate → inspect → act

| Verb | What it does |
|---|---|
| `page` | Orientation skeleton: title/url, landmarks, headings, frames, counts. ~300 bytes. |
| `fields` | One line per form field across ALL frames: `ref kind "label" value flags [frame fN]`. **Mints the refs** every verb below uses. |
| `perceive [--width N] [--crop <ref>]` | **The capture pass** (first visit / drift recovery): fields listing + `perceive.json` fingerprints (per-ref durable signals: domId/testId, nameSource, nearestHeading/landmark, collision counts, bbox — structure only, never values) + a ref-badged screenshot at 768px (red=field, blue=top nav, green=iframe nav; badges are the real refs — Read the PNG). One enumeration feeds all three, so text/JSON/image share one keyspace. Bboxes are bracket-sampled around the shot; animated refs are flagged `unstable`. `--crop` emits a native-res cutout for pixel-only content. |
| `field <ref> [--filter s]` | One field's contract as JSON: kind, value, constraints, options (capped; `--filter` narrows a huge select), `howToSet`. Probes a combobox (side-effect-safe) to refine static vs async. |
| `field-fill <ref> <value>` | Set a text/date field; reads back the committed value as the receipt. `--data-ref <key>` fills a PHI value resolved in-process (never on argv/stdout; length-only receipt). |
| `field-select <ref> --pick <label>` | Commit a choice. Dispatches per species: native select, static combobox, async autocomplete (add `--query <text>` or PHI `--query-ref <key>`; waits for the "N results available" live region), virtualized listbox (arrow-walk). Match ladder: exact → normalized → unambiguous substring. Ambiguity prints candidates + a retry line — it never guesses. |
| `help [verb]` | The manual, from the CLI itself. Works with no browser connected. |

## Rules

- **Refs come only from `fields` and die on any page change.** Every stale-ref
  error says exactly what to do (`re-run: fields`) — obey it.
- **When confused, go UP a perception level** — re-run `fields` or `page`;
  don't retry the failing action.
- **Tiering** (agent playbook, `automation.ts`): API shortcut (`net-observe`/
  `net-replay`) → saved tool (`breeze-tools`) → **field layer** → raw verbs
  (`snapshot`/`click`/`fill`, only for ARIA-less div-soup).
- Sensitive fields (password, cc-*) are masked at the source — values print as
  `«filled»`, never plaintext.
- Every invocation ends with a `[timing] <verb> in=<iso> out=<iso> (ms)` receipt.

## Perceive once, act from memory

Run-N speed is the goal (see
[`operator-speed/perceive-once-act-from-memory.md`](operator-speed/perceive-once-act-from-memory.md)):

- **First visit** to a repeatable page: `perceive`, Read the PNG, do the work,
  then store the used fields' fingerprints + proven recipes (species, receipt,
  idempotence, ambiguity discriminators) via TypeBuild `remember_site` —
  structure only, never values.
- **Next visit**: `recall_site` FIRST. If memory covers the page, one cheap
  `fields` to re-mint refs (matched to remembered fingerprints by
  label/domId), then act straight through — no `perceive`, no screenshot, no
  re-probing. Bypass perception unless an error occurs.
- **On error only** (stale ref / ambiguous / receipt mismatch): go up a
  perception level, fix the step, and write the corrected memory back.
- Never blind-retry a non-idempotent action (toggle, submit) after an unclear
  outcome — re-perceive first. Screenshots are per-page working state: don't
  carry old pages' PNGs forward in context.

## Testing

Deterministic fixtures for every widget species live in
`electron/browser/fixtures/` (`validate-fixtures.mjs` for static checks;
`run-fixture-tests.mjs --yes` drives the real CLI — it navigates the shared
operator page, so restore it after). Foundation self-test:
`node electron/browser/perceive.selftest.mjs`.

Built under epic `task-894df344f4f6`; internals: `perceive.mjs` (merged tree,
ref map, staleness guard) and `field-verbs.mjs` (classifier, renderers, setters).
