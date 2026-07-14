# Task-intake architecture: a task should ARRIVE resolved

**Status:** Proposed (design) — implementation pending
**Date:** 2026-07-14
**Epic:** Operator Speed (TypeBuild task-32b7db557a49); this doc is task-4bd791686ef7
**Audience:** Breeze client + TypeBuild server teams
**Related (read these, don't duplicate them):**
- [`docs/pii-data-injection-design.md`](../pii-data-injection-design.md) — the three data classes, the `me.*`/entity vault, the cooperative PHI boundary. **The reference-vs-value split here is theirs; this doc reuses it.**
- [`docs/typebuild-data-field-contract.md`](../typebuild-data-field-contract.md) — the task `data` bag (flat `string→string`, keys non-PHI, values encrypted, resolved one-per-call).
- `electron/typebuild/task-context-bundle.ts` — the existing NON-PHI relevant-sites+memories bundle fetched at launch (`GET /chromeext/<id>/context-bundle`). **This doc extends it.**
- `electron/typebuild/task-work-bundle.ts` — the PHI-bearing first-turn work bundle assembled at launch. **This doc adds sections to it.**
- `electron/typebuild/site-memory.ts`, `electron/browser/tools/memory.mjs` — the two memory surfaces. Sibling **task-28c6c1d085f9** is unifying them into ONE lookup surface; this doc assumes that unified surface and does not re-specify it.
- `skills/typebuild-work/SKILL.md` (typebuild-plugin) — the work loop the intake feeds.

---

## 1. The problem, and what it cost

A real prior-auth run (insurance authorization class) opened with task intake handing the operator an **opaque `carrier_code`** (e.g. `"OAET14"`) plus a patient/insurance JSON blob — and **nothing else**. The blob said *what* the patient needs but not *where* or *how* to act. So the agent's first ~10 tool calls were pure **discovery**, ZERO of them a browser action:

| # | Call | Why it was wasted |
|---|------|-------------------|
| 1–3 | guess payer domain, `goto aetna.com`, `goto availity.com`, `goto aetna.com/providers` | intake never said which payer `OAET14` is, or which portal to use — all misses |
| 4–5 | `recall_site aetna.com`, `recall_site availity.com` | recalling memory for the wrong (guessed) domains |
| 6 | `list_entities` | to learn WHICH vault entity is the requesting HCP / servicing facility |
| 7 | `get_entity <guessed id>` | to confirm the guess |
| 8–9 | `recall_task`, more `recall_site` | second memory system, queried separately |
| 10 | re-derive "septo/srt" → ICD-10 + CPT by hand | shorthand the intake never expanded |

Only after all of that could the agent take its **first real action**. Every one of those calls is answerable **at task-create time** from data the creator already has or can resolve once. The discovery loop is not intelligence — it is the intake schema failing to carry resolved detail.

**Thesis:** a task should ARRIVE resolved. The agent's **first tool call should be a browser/API/tool action**, because payer, portal, entities, codes, and memory were all resolved *before* the task landed in the queue and are delivered *in the claim/get payload*. Discovery moves from per-run (paid every time, by the agent) to per-create (paid once, by the creator or a resolver step).

This composes with two intake work already in flight, which this doc treats as dependencies (see §5): the **carrier_code→payer table** (task-2f7913f7bb87) and **payer-resolution-at-intake** (task-1dca08d17d48).

---

## 2. The intake schema

### 2.1 Where each field lives (the load-bearing split)

Everything in intake is one of two things, and they live in **different stores** by their PHI class (per `pii-data-injection-design.md`):

- **REFERENCES / routing (NON-PHI):** payer identity, portal URL, `entity_id` handles, code mappings, `carrier_code`, unresolved flags. These are **shared, plaintext, server-readable, cacheable**, and safe to log. They ride the task **skeleton** (the plaintext routing store) and flow to the agent **in cleartext** in the claim payload. They tell the agent *where and how* to work.
- **VALUES (PHI):** the actual member ID, DOB, SSN, patient name. These NEVER appear in intake as values. They live encrypted in the task **`data` bag** as `data_keys` (patient PHI) or resolve from the **entity vault** (the user's own identifiers). The agent fills them by **placeholder key** at fill time via `fill-ref`/`type-ref`; main resolves the value one-per-call, and the agent never sees it.

The intake schema below carries **references only**. This is what makes it safe to resolve at create time, cache server-side, and inject into the agent's opening context.

### 2.2 The `intake` object

A new **`intake`** member on the task, alongside `title`/`task`/`data`. It is a structured, **NON-PHI** object (server-readable, part of the routing skeleton, NOT the encrypted PHI store). Shape for an insurance-authorization-class task:

```jsonc
{
  "intake": {
    "class": "insurance_authorization",   // selects which resolver + which fields are required

    "payer": {
      "carrier_code":   "OAET14",                       // string, REFERENCE — the raw upstream code
      "payer_id":       "aetna",                         // string, REFERENCE — canonical payer key (from carrier→payer table)
      "payer_name":     "Aetna",                         // string, VALUE(non-PHI) — display
      "portal_url":     "https://apps.availity.com/...", // string, REFERENCE — where the work happens
      "portal_domain":  "availity.com",                  // string, REFERENCE — memory lookup key (Aetna auths route via Availity)
      "fax_number":     null,                            // string|null — fallback channel if no portal
      "form_location":  "Auth & Referrals > Authorizations", // string|null — in-portal path to the form, if known
      "resolved":       true                             // bool — false ⇒ see intake.unresolved
    },

    "requesting_hcp": {
      "entity_id":  "ent_9f2c...",   // string, REFERENCE — vault entity id of the requesting provider
      "label":      "Dr. A. Rivera / NPI on file",  // string, VALUE(non-PHI) — human label ONLY, not the NPI itself
      "resolved":   true
    },
    "servicing_facility": {
      "entity_id":  "ent_4b81...",   // string, REFERENCE — vault entity id of the servicing facility
      "label":      "Northside Surgery Center",
      "resolved":   true
    },

    "codes": {
      "shorthand": "septo/srt",       // string — the raw upstream shorthand, kept for provenance
      "icd10":  [                      // array, REFERENCE — non-PHI code mappings, resolved up front
        { "code": "J34.2", "label": "Deviated nasal septum" }
      ],
      "cpt":    [
        { "code": "30520", "label": "Septoplasty" },
        { "code": "30140", "label": "Submucous resection turbinate" }
      ],
      "resolved": true
    },

    "phi_refs": {                      // POINTERS ONLY — the keys, never the values
      "member_id":     "patient.member_id",   // → task data bag key (encrypted value resolved at fill time)
      "patient_dob":   "patient.dob",
      "patient_name":  "patient.name"
    },

    "unresolved": [],                  // array of {field, reason} — see §4. Empty ⇒ fully ready to act.

    "intake_version": 1                // schema version for forward-compat
  }
}
```

### 2.3 Field-by-field

| Field | Type | Ref vs Value | PHI? | Populated at create by | If unresolved |
|-------|------|--------------|------|------------------------|---------------|
| `class` | enum | — | No | Creator (task template / caller) | Required; reject create if absent for an intake task |
| `payer.carrier_code` | string | Reference | No | Creator (raw upstream code) | N/A — this is the input to resolution |
| `payer.payer_id` | string | Reference | No | **Resolver** via carrier→payer table (task-2f7913f7bb87) | `unresolved:[{field:"payer",reason:"carrier_code_unmapped"}]`; `payer.resolved=false` |
| `payer.payer_name` | string | Value (non-PHI) | No | Resolver (display) | omit |
| `payer.portal_url` | string | Reference | No | Resolver / payer table | flag "payer unresolved" |
| `payer.portal_domain` | string | Reference | No | Resolver — the memory + site-detection key | flag; agent falls back to live `recall_site` |
| `payer.fax_number` | string\|null | Reference | No | Resolver, when no portal exists | null is fine (portal path) |
| `payer.form_location` | string\|null | Reference | No | Resolver / prior site memory | null ⇒ agent navigates by skill |
| `requesting_hcp.entity_id` | string | **Reference** | No (handle) | Resolver — maps practice/provider → vault entity id | `unresolved:[{field:"requesting_hcp",reason:"..."}]`; agent must `list_entities` (the OLD path) |
| `requesting_hcp.label` | string | Value (non-PHI) | No | Resolver | omit |
| `servicing_facility.entity_id` | string | **Reference** | No (handle) | Resolver | flag "facility unconfirmed" |
| `codes.shorthand` | string | — | No | Creator (raw) | kept for provenance |
| `codes.icd10[]` / `codes.cpt[]` | array of `{code,label}` | Reference | No | Resolver — shorthand→code map | `unresolved:[{field:"codes",...}]`; agent derives at run time (old path) |
| `phi_refs.*` | string (a `data`-bag KEY) | **Pointer to a value** | key No / value **YES** | Creator — must match a `data_keys` entry | if a key is missing, that PHI wasn't attached — flag it |
| `unresolved[]` | array of `{field,reason}` | — | No | Resolver | the whole point (§4) |

**Why `entity_id`, not the raw NPI/EIN.** The requesting HCP and servicing facility resolve to a **vault entity id** — an opaque, non-PHI handle. This is exactly the class-2 mechanism already shipped: the resolver in `task-data.ts` already accepts `entity=<id>` on `GET /chromeext/entities/resolve?field=<name>&entity=<id>` (today it defaults to the `me` self-entity). Carrying `entity_id` in intake means at fill time the client resolves `me.npi` **against that specific entity** instead of guessing — and the raw NPI value still resolves **client-side, one-per-call, never on the server-visible intake, never in the agent's context**. Intake carries the *handle*; the *value* stays in the vault. This is the single change that eliminates discovery calls #6 and #7 above.

**PHI discipline restated.** The entire `intake` object is NON-PHI and lives in the plaintext skeleton. `label` fields are deliberately human-display-only ("Dr. A. Rivera / NPI on file") — **never the NPI, member id, or DOB**. Actual PHI stays in the encrypted `data` bag (`phi_refs` points at its keys) or the vault (via `entity_id`), and only ever resolves through main at fill time.

---

## 3. The claim_task / get_task auto-bundle change

### 3.1 What exists today

At interactive launch (`electron/sources/typebuild.ts`, ~L4358 wave 1), Breeze already fetches **in parallel**:
- `contextBundleAddendum` — the NON-PHI relevant-sites + their memories, rendered by `task-context-bundle.ts` from a **server-prepared, server-cached** bundle (`GET /chromeext/<id>/context-bundle`), injected via `--append-system-prompt`.
- `detail` (getTask) — title/body/dataKeys/outputSchema/skills.

Then wave 2 resolves each `data_keys` value and `buildTaskWorkBundle` assembles the PHI-bearing first-turn message injected over the pty's stdin.

So **the auto-bundle mechanism already exists in two halves**: a NON-PHI addendum (context-bundle) and a PHI first-turn (work-bundle). The intake change extends **both**, and adds **pre-fetched memory** to the NON-PHI half. We are not inventing a delivery channel — we are filling the existing ones with resolved intake + recalled memory.

### 3.2 What the server pre-fetches, and where

**At CREATE time (async, server-side)** — the same model `task-context-bundle.ts` already assumes ("relevant-site detection + recall lookups run server-side, asynchronously right after create_task, cached by the opaque task id"). We extend that server job so that, once `intake.payer.portal_domain` and the `entity_id`s are known, it ALSO runs — **at create/resolve time, once** — the memory recalls the agent used to make itself:

- `recall_site(portal_domain)` — notes for the payer's portal (e.g. Availity auth quirks).
- `recall_site(<any additional intake-relevant domains>)`.
- `recall_task(<task-type tag>)` — learnings for this task *class* (e.g. "insurance_authorization"), not just this task id, so a brand-new task inherits the type's accumulated how-to.
- The relevant `remember_site` notes those recalls return.

These are recalled through the **unified memory surface** that sibling **task-28c6c1d085f9** is building (ONE lookup, not the two separate `site-memory.ts` / `memory.mjs` stores). This doc **does not** re-specify that surface — it names it as the dependency and consumes its single recall entrypoint. All of this is NON-PHI (memory is PHI-guarded at write, 422 on a value), so it is safe to cache server-side keyed by the task id, exactly like the existing context-bundle.

### 3.3 Shape of the response payload

The server's context-bundle response (`GET /chromeext/<id>/context-bundle`, today `{task_id, version, ready, body, sites}`) gains structured intake + pre-attached memory:

```jsonc
{
  "task_id": "task_...",
  "version": 3,
  "ready": true,                    // false while async resolution/recall still running → client injects nothing, no block
  "intake": { /* the §2 object, NON-PHI */ },
  "memory": {                       // pre-attached recalls — the agent's recall_* calls, ALREADY MADE
    "sites": [
      { "domain": "availity.com", "notes": [ { "kind": "gotcha", "body": "Auth form is under Auth & Referrals; TIN picker defaults wrong." } ] }
    ],
    "task_type": [
      { "tag": "insurance_authorization", "notes": [ { "body": "Attach clinical note PDF before submit or it 400s." } ] }
    ]
  },
  "body": "…rendered NON-PHI Markdown (back-compat: sites+memories prose)…",
  "generated_at": "2026-07-14T…"
}
```

- `ready:false` keeps the existing non-blocking contract — if resolution/recall hasn't finished, the client injects nothing and the agent falls back to live discovery (**non-regression**).
- `intake` and `memory` are **structured**, so the client can render them precisely; `body` stays for back-compat.

### 3.4 How it's shaped into what the agent sees

Two injection seams, matching the existing split — **no PHI value ever moves from its store into intake or the addendum**:

1. **NON-PHI → `--append-system-prompt`** (extend `renderBundleAddendum` in `task-context-bundle.ts`). A new section:

   ```
   # Resolved task intake (act on this directly — do NOT re-discover)
   Payer:     Aetna — portal https://apps.availity.com/... (domain availity.com)
              Form: Auth & Referrals > Authorizations
   Requesting provider: entity ent_9f2c... (Dr. A. Rivera / NPI on file)
   Servicing facility:  entity ent_4b81... (Northside Surgery Center)
   Diagnosis (ICD-10): J34.2 Deviated nasal septum
   Procedure (CPT):    30520 Septoplasty; 30140 Submucous resection turbinate
   Unresolved: (none)          # or: "payer unresolved", "facility unconfirmed"

   # Pre-fetched memory (treat as already-recalled — do NOT call recall_site/recall_task for these)
   availity.com: Auth form is under Auth & Referrals; TIN picker defaults wrong.
   [task type insurance_authorization]: Attach clinical note PDF before submit or it 400s.
   ```

   The existing addendum header already tells the agent "treat as already-recalled; do NOT make extra recall_site/recall_task calls" — the intake block extends that instruction to payer/entity/code discovery too.

2. **PHI keys → work bundle over stdin** (extend `buildTaskWorkBundle` in `task-work-bundle.ts`). The work bundle already carries resolved `data_keys` values. It gains a **"Fill references"** section that maps each intake `phi_refs` entry to its placeholder key AND names the `entity_id` to resolve the user's own identifiers against:

   ```
   # Fill references (fill by KEY via fill-ref/type-ref — you never see the value)
   Member ID:   {{patient.member_id}}
   Patient DOB: {{patient.dob}}
   Requesting NPI: resolve me.npi against entity ent_9f2c...   # client resolves; you never type it
   Facility TIN:   resolve me.tax_id against entity ent_4b81...
   ```

   PHI discipline is unchanged: the work bundle rides the stdin channel only, never argv/disk/`--append-system-prompt`, per `task-work-bundle.ts`'s existing header. Intake `entity_id`s are non-PHI handles and could ride either channel; they go on the work-bundle side so the fill instructions sit next to the placeholder keys they pair with.

---

## 4. The `unresolved` flags mechanism, and how the agent branches

`intake.unresolved` is an array of `{ field, reason }`. **Empty ⇒ the task is fully actionable; the agent proceeds straight to the browser.** Non-empty ⇒ specific, machine-named gaps.

```jsonc
"unresolved": [
  { "field": "payer",              "reason": "carrier_code_unmapped" },
  { "field": "servicing_facility", "reason": "no_matching_entity" }
]
```

**Reason vocabulary (extensible):** `carrier_code_unmapped`, `portal_unknown`, `no_matching_entity`, `ambiguous_entity`, `codes_unmapped`, `phi_key_missing`.

**How the agent branches** (this is added to the SKILL's step 2/pre-work):

- **`unresolved` empty** → first action is a real action: `goto payer.portal_url`, then work the form. No discovery.
- **`payer` unresolved** → payer/portal/domain are untrustworthy. The agent must NOT guess domains (the exact original failure). It **asks the user** ("carrier_code OAET14 didn't map to a payer — which portal?") via `ask_user`/`notify_user`, or falls back to the OLD live path *knowingly*. It does not silently blunder.
- **`requesting_hcp` / `servicing_facility` unresolved** → the `entity_id` is missing/ambiguous. The agent falls back to `list_entities` + confirm **for that one entity only** — the narrow old path, not a full cold start — or asks the user which entity applies.
- **`codes` unresolved** → the agent derives ICD-10/CPT from `codes.shorthand` at run time (old behavior) and should `remember` the mapping so the resolver can learn it.
- **`phi_key_missing`** → a `phi_refs` pointer has no matching `data_keys` entry: the PHI wasn't attached at create. The agent cannot fabricate it — it asks the user.

The design intent: **the flag tells the agent exactly what is ready vs. what needs a check-in, so a partially-resolved task still lets the agent act on the resolved parts immediately and only pause on the specific gap** — instead of treating the whole task as opaque and discovering everything.

---

## 5. Sequencing & dependencies

This intake schema is the **integration point** for several sibling efforts. It does not re-implement them; it defines the shape they populate and the payload they ride.

```
carrier_code→payer table              payer-resolution-at-intake
(task-2f7913f7bb87)                   (task-1dca08d17d48)
        │  provides payer_id,                 │  runs the resolver at create time,
        │  portal_url, domain, fax            │  writes intake.payer.* + unresolved flags
        └───────────────┬─────────────────────┘
                        ▼
             §2 intake schema  ◄── THIS DOC (task-4bd791686ef7)
                        │   defines intake object + entity_id/code/phi_refs fields
                        ▼
   memory-unification (task-28c6c1d085f9)  ── ONE recall surface the §3.2 create-time
                        │                       job calls to pre-attach memory
                        ▼
             §3 auto-bundle (extends task-context-bundle.ts + task-work-bundle.ts)
                        │   injects intake + pre-attached memory at claim/launch
                        ▼
   startup skill (typebuild-work SKILL.md; dangling-skill startup task-b2420370deaa)
                        │   consumes intake: "first action is a browser action";
                        └── branches on intake.unresolved (§4) instead of discovering
```

- **task-2f7913f7bb87 (carrier→payer table)** — the lookup that turns `carrier_code` into `payer_id`/`portal_url`/`portal_domain`. Intake's `payer` block is its output shape. Dependency of resolution.
- **task-1dca08d17d48 (payer-resolution-at-intake)** — the create-time resolver that fills `intake.payer.*` (and sets the `payer` unresolved flag on a miss). Produces §2's payer block.
- **task-28c6c1d085f9 (memory unification)** — the ONE recall surface §3.2's create-time job calls. This doc assumes it and does not re-specify either store.
- **task-b2420370deaa (dangling-skill startup) + SKILL.md** — the startup path that consumes the bundle. The SKILL's loop step "Open a NEW tab at the skill's start URL" becomes "open `intake.payer.portal_url`"; a new pre-work check reads `intake.unresolved` and branches per §4. The intake block must therefore render into the **same first-turn context** the startup skill already reads (the work-bundle + the context-bundle addendum — both already delivered before the agent's first turn).

**Ordering:** carrier→payer table and memory-unification are upstream (data + surface). Payer-resolution-at-intake writes the schema this doc defines. The auto-bundle change (§3) is the client-side consumer and can land incrementally: render whatever intake fields are present, `ready:false`/absent fields degrade to today's live discovery (non-regression throughout).

---

## 6. Before vs. after: the same task

### BEFORE (today — ~10 discovery calls, first browser action at step ~8)

```
intake in: { carrier_code: "OAET14", patient: {…blob…} }

1.  goto aetna.com                         → generic marketing page (miss)
2.  goto availity.com                      → login wall, unsure if right portal (miss)
3.  goto aetna.com/providers               → wrong (miss)
4.  recall_site aetna.com                  → empty (wrong domain)
5.  recall_site availity.com               → some notes, but unsure it's the payer
6.  list_entities                          → learn which vault entity is the provider
7.  get_entity ent_9f2c...                 → confirm the requesting HCP
8.  recall_task <id>                        → second memory system
9.  recall_site availity.com (again)        → re-recall now that payer is "known"
10. (mentally) septo/srt → J34.2 / 30520,30140   → re-derive codes
──  FIRST BROWSER ACTION toward the actual form: ~step 8+, after ~10 calls
```

### AFTER (intake resolved — first tool call IS the browser action)

```
Claim payload already contains:
  intake.payer   = Aetna, portal https://apps.availity.com/..., domain availity.com,
                   form "Auth & Referrals > Authorizations", resolved:true
  intake.requesting_hcp.entity_id     = ent_9f2c...   (Dr. A. Rivera)
  intake.servicing_facility.entity_id = ent_4b81...   (Northside Surgery Center)
  intake.codes = ICD-10 J34.2; CPT 30520, 30140       (from "septo/srt")
  intake.phi_refs = { member_id, patient_dob, patient_name } → data-bag keys
  intake.unresolved = []                              ← nothing to check; act
  memory: availity.com "TIN picker defaults wrong"; task-type "attach clinical note PDF"

1.  goto https://apps.availity.com/...      ← FIRST TOOL CALL IS A REAL ACTION
2.  navigate Auth & Referrals > Authorizations   (form_location, no hunting)
3.  fill-ref {{patient.member_id}}, {{patient.dob}}   (PHI by key; never seen)
4.  resolve me.npi @ ent_9f2c... into the NPI field   (correct entity, no list_entities)
5.  fill CPT 30520/30140, ICD-10 J34.2                (pre-mapped, no re-derivation)
6.  (heeds memory) fix TIN picker; attach clinical note PDF before submit
7.  STOP at final submit → human gate (SKILL rule 1)
```

The ~10-call discovery loop collapses to zero: payer, portal, form path, entities, and codes arrived resolved, and the two memory recalls were pre-attached. The agent spends its calls **doing the work**, not finding it.

---

## 7. Open questions for Vivek

1. **`intake` store placement.** This doc puts the whole `intake` object in the **plaintext routing skeleton** (it's NON-PHI: refs, handles, code mappings, display labels). Confirm that's right — the alternative is riding it in the encrypted store next to `data`, which would be more conservative but forces every routing read through decryption. Recommendation: skeleton (plaintext), matching the reasoning in `task-phi-schema.mjs`'s two-store split.

2. **`label` fields and PHI leakage risk.** `requesting_hcp.label` / `servicing_facility.label` are meant as non-PHI display only. A careless creator could put "Dr. Rivera, NPI 1234567890" in a label. Do we PHI-guard the intake write server-side (422 on PHI-shaped label text) the way memory/skill writes are guarded? Recommendation: yes, guard it.

3. **Who runs create-time resolution.** §3.2 assumes an async server-side job (mirroring the existing context-bundle prep). But payer/entity/code resolution may need **client-side** data (the entity vault is per-user, resolved through main). Does resolution split — payer/codes server-side, entity_id mapping client-side (at first claim, cached) — or does the creating client do all of it before create? This affects whether `entity_id` can be filled at create or only at first claim. Needs a decision; it changes where the `no_matching_entity` flag is first set.

4. **Task-type tag for `recall_task`.** §3.2 recalls by task *type* (e.g. `"insurance_authorization"`) so a new task inherits the class's learnings. What is the canonical source of that tag — `intake.class`, the project, the template id? Recommendation: `intake.class` is the natural key, but confirm it's stable enough to be a memory bucket.

5. **Multi-entity disambiguation at intake.** `pii-data-injection-design.md` flags that a user may have several NPIs (one per location) and the shipped model uses separate entities. Intake's `entity_id` resolves that at create time — but only if the resolver can pick the right location entity from the task context. Is location inference in scope for payer-resolution-at-intake (task-1dca08d17d48), or does an ambiguous case just emit `ambiguous_entity` and defer to the agent/user? Recommendation: emit `ambiguous_entity` for v1; location inference is a follow-up.
