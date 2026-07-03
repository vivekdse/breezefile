// task-ae0ec0348930 — the PURE effect-application reducer for the FormExtension
// interpreter, extracted to a dependency-free .mjs so it can be unit-tested under
// `node --test` (the TS module src/copilot/formExtensions.ts re-exports these).
//
// The interpreter APPLIES declarative effects only — it never eval's the logic
// and never injects markup. These functions are the guard: they keep ONLY the
// four allowlisted effect keys and drop any malformed sub-value, so a compromised
// or erroneous server response can't smuggle behavior into the client.

/** The four effect keys the interpreter honors. Any other key is IGNORED. */
export const EFFECT_KEYS = ['setValue', 'setVisible', 'setOptions', 'validate'];

/** A fresh, empty interpreter state (hidden / dynamic options / errors). */
export function emptyInterpreterState() {
  return { hidden: {}, options: {}, errors: {} };
}

/** Coerce an arbitrary run-logic `effects` payload into a sanitized effects
 *  object, keeping ONLY the four allowlisted keys and dropping malformed
 *  sub-values. Pure. Never throws. */
export function sanitizeEffects(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of EFFECT_KEYS) {
    const v = raw[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (key === 'setValue') {
      out.setValue = { ...v };
    } else if (key === 'setVisible') {
      const clean = {};
      for (const [fk, val] of Object.entries(v)) {
        if (typeof val === 'boolean') clean[fk] = val;
      }
      if (Object.keys(clean).length) out.setVisible = clean;
    } else if (key === 'setOptions') {
      const clean = {};
      for (const [fk, val] of Object.entries(v)) {
        if (Array.isArray(val)) clean[fk] = val.filter((o) => typeof o === 'string');
      }
      if (Object.keys(clean).length) out.setOptions = clean;
    } else if (key === 'validate') {
      const clean = {};
      for (const [fk, val] of Object.entries(v)) {
        if (typeof val === 'string') clean[fk] = val;
        else if (val === null) clean[fk] = null;
      }
      if (Object.keys(clean).length) out.validate = clean;
    }
  }
  return out;
}

/** Apply sanitized effects to the interpreter state (hidden/options/errors),
 *  returning a NEW state (pure — never mutates inputs). `setValue` writes are NOT
 *  applied here (they belong to the shared value store); this owns only the
 *  interpreter's own per-field presentation state. Additive: keys the effects
 *  don't mention are left untouched. */
export function applyEffectsToState(state, effects) {
  const next = {
    hidden: { ...state.hidden },
    options: { ...state.options },
    errors: { ...state.errors },
  };
  if (effects.setVisible) {
    for (const [fk, visible] of Object.entries(effects.setVisible)) {
      if (visible) delete next.hidden[fk];
      else next.hidden[fk] = true;
    }
  }
  if (effects.setOptions) {
    for (const [fk, opts] of Object.entries(effects.setOptions)) {
      next.options[fk] = opts;
    }
  }
  if (effects.validate) {
    for (const [fk, msg] of Object.entries(effects.validate)) {
      if (msg == null || msg === '') delete next.errors[fk];
      else next.errors[fk] = msg;
    }
  }
  return next;
}

/** Compute the value writes a `setValue` effect prescribes, coerced to strings
 *  (the shared form value store's shape). Pure. */
export function valueWritesFromEffects(effects) {
  const out = {};
  if (!effects.setValue) return out;
  for (const [fk, val] of Object.entries(effects.setValue)) {
    if (val == null) continue;
    out[fk] = typeof val === 'string' ? val : String(val);
  }
  return out;
}

/** Resolve which approved extension applies to a template/project, by matching
 *  `appliesTo.template`. Simple v1 lookup; returns the first match or null. */
export function resolveApplicableExtension(extensions, templateKey, projectId) {
  if (!templateKey) return null;
  for (const fx of extensions) {
    if (fx.status !== 'approved') continue;
    const at = fx.appliesTo;
    if (at && at.template === templateKey) {
      if (fx.projectId && projectId && fx.projectId !== projectId) continue;
      return fx;
    }
  }
  return null;
}
