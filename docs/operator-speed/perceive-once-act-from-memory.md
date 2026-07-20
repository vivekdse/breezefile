# Perceive once, act from memory: compressing the loop across repetitions

**Status:** Proposed (design) — implementation tracked in TypeBuild task-b966cc60c2e2
**Date:** 2026-07-20
**Epic:** Operator Speed (TypeBuild task-23b99b1d2675)
**Companion:** [`task-intake-architecture.md`](task-intake-architecture.md) — compresses the
loop **before** the page (a task should ARRIVE resolved). This doc compresses the loop
**on** the page (a page should ARRIVE perceived). Together: run N of a task type starts
with payer/portal/entities/codes resolved *and* the form's fields already known.
**Related:** [`../browser-field-verbs.md`](../browser-field-verbs.md) (the perception/action
verbs this rides on), `electron/browser/perceive.mjs` (merged tree — the one perception
source), `electron/browser/automation.ts` (the tier playbook this adds a rung to).

---

## 1. The principle: we are building for run N, not run 1

Almost every task the operator exists for is **repetitive**: the fourth prior-auth on
Availity, the tenth eligibility check, the same portal form with different patient data.
The goal is therefore NOT to make the first run fast. The first run is allowed to be
slow, careful, and exploratory — because its job is to make **every subsequent run**
skip the work it just did.

The unit being optimized is the loop the agent runs per interaction:

```
perceive the page → decide what/where → act → verify → next
```

On run 1, every step is paid in full: full-tree perception (`fields`, ~500ms on a real
portal page), widget probing, disambiguation reasoning, receipt discovery. The design
requirement is that this loop **compresses monotonically with repetition**:

| Loop step | Run 1 (learning) | Run N (from memory) |
|---|---|---|
| Perceive | full merged-tree `fields` + probing | **skipped** — fingerprints recalled from memory |
| Decide | agent reasons over the enumeration | **skipped** — recipe recalled (species, how to set, what to expect) |
| Act | act by ref, discover quirks (async combobox, toggle) | act by certified descriptor, quirks pre-known |
| Verify | discover what "success" looks like | cheap receipt check against the recorded expectation |

Run N's floor is: one deterministic resolution + one action + one receipt read per field
— tens of milliseconds each, no tree walk, no reasoning tokens. Perception is an
**amortized capital cost paid at capture time, not an operating cost paid per run.**

## 2. What makes skipping perception safe (not reckless)

Skipping perception is only acceptable because every action still carries its own
verification. The load-bearing swap is:

> **Full perception per run  →  certified memory + per-action receipts + escalation on drift.**

- **Certified at capture:** perception time is when disambiguation is cheap — the whole
  tree is in hand. So perception does not merely record signals; it SOLVES resolution
  and stores the solution: for each field, the minimal signal combination proven to
  match exactly one element on this page (`matchedAtCapture: 1 of N`), the ambiguity
  analysis (8 identical "More..." buttons; discriminator = nearest tile heading), and
  honest flags for the non-uniquifiable (ordinal picks, needs-runtime-scope row
  patterns). Memory is born with proof, not hope.
- **Receipts per action:** every remembered action records what success observably looks
  like (committed value read-back, `aria-expanded` flip, URL change) and whether the
  action is idempotent. Run N verifies each step against that expectation in
  milliseconds — verification never gets skipped, only *perception* does.
- **Drift, not mystery:** the act-time uniqueness gate re-runs the capture-time count.
  "Matched 2 now, matched 1 at capture" is a precise drift diagnosis, and any failure
  drops the agent one perception level (targeted probe → `fields` → `page`), completes
  the step the slow way, and **writes the corrected memory back** — so a portal redesign
  costs one slow run, not a broken automation. Failures cost latency, never correctness.

## 3. The two-layer split (settled — see task-b966cc60c2e2 for the full spec)

- **Deterministic layer** (`field-interact`, CLI): stateless pure function. Descriptor +
  action in → structured outcome + evidence out. One resolution attempt, uniqueness
  gate, trusted input events, bounded receipt wait. Never guesses, never retries, never
  falls back, never gets smarter.
- **Intelligence layer** (agent): owns all memory (TypeBuild `remember_site` /
  `recall_site`; structure only, never PHI values), decides when to trust it, escalates
  perception on failure, and writes back what it learns. The tool stays dumb; the
  *descriptors it is fed* get smarter — that is where the compression accumulates.

## 4. Where this sits in the speed tiers

The playbook rung order becomes:

```
1. API shortcut        (net-observe/net-replay — the fastest click is no click)
2. Saved tool          (breeze-tools)
3. REMEMBERED FIELDS   ← this doc: act from certified fingerprints, no perception
4. Live field layer    (page/fields/field — full perception; also the capture mode
                        that FEEDS tier 3)
5. Raw verbs           (snapshot/click/fill — ARIA-less div-soup only)
```

Tier 4 is demoted from "the normal way to work a form" to two roles: the **first-run
capture pass** and the **recovery path when tier 3 hits drift**. A healthy mature task
type touches tier 4 rarely; every time it does, tier 3 gets better.

## 5. The compounding loop, end to end

```
run 1:  intake arrives resolved (companion doc) → goto portal_url
        → fields (full perception) → certify fingerprints → act by ref,
        learning recipes/receipts → remember_site: fingerprints + recipes
run 2:  recall_site → field-interact per remembered step (no perception)
        → receipts green → done in a fraction of run 1's calls and tokens
run 3+: same, plus trust ledger accrues (hits/misses per fingerprint)
drift:  one step fails honestly → agent re-perceives THAT step → fixes →
        writes back → run N+1 is fast again
```

Because memory lives in TypeBuild (shared across machines and teammates), one person's
run 1 is everyone's run 2.

## 6. Non-goals / guardrails

- **Not** first-run speed at the cost of learning quality: run 1 should over-invest
  (certify, record receipts, note idempotence) precisely so runs 2..N can skip.
- **Not** skipping verification: receipts are mandatory on the fast path; only
  enumeration is skipped. `receipt-mismatch` on a non-idempotent step means re-perceive,
  never blind-retry (a retry on a toggle inverts it; on a submit it double-submits).
- **Not** a parallel perception stack: fingerprints are extracted from the same merged
  tree `perceive.mjs` builds. One perception source, or the two views drift apart.
- **PHI discipline unchanged:** memory stores structure (labels, fingerprints, recipes)
  — never values. Values ride the task data bag / entity vault and resolve in-process
  at fill time. Final submits keep the human gate regardless of how fast the path is.
