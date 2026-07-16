// Feed run-metrics threshold breaches back to the brain (task-1334a1d49948
// "Brain C3"), reusing the C1 write path (electron/typebuild/brain-writes.ts
// captureObservation, via electron/typebuild/site-memory.ts).
//
// WHY A CONTROL-API HOP. This module runs inside the electron/browser/cli.mjs
// subprocess — a bare Node process with NO Firebase session (see
// electron/typebuild/auth.ts: getIdToken() needs an in-memory session that
// only ever exists in Breeze MAIN). Exactly like site-memory's `memory`
// CLI reaching /app/site-memory (electron/browser/tools/memory.mjs) and
// cli.mjs's fill-ref reaching /app/task-data (connect.mjs resolveDataRef),
// this reaches captureObservation THROUGH main's localhost control API,
// which holds the real token.
//
// NON-PHI ONLY: every field sent is a verb name, a domain, timing numbers,
// and a streak count — never a selector value, URL path/query, or typed
// content. Fire-and-forget: a report failure (offline main, no auth, brain
// down) must never fail or slow the run the metric describes.

import { readApi, API_FILE } from '../connect.mjs';

/**
 * Report one threshold breach (as returned by run-metrics.mjs's
 * recordVerb/timeVerb) to the brain as a 'task'-tier observation — scoped to
 * THIS run, matching the ephemeral nature of a single run's timing profile.
 * The curator's periodic sweep is what promotes a RECURRING pattern (seen
 * across many runs) up to an org/global-tier tool proposal; this call is just
 * the raw per-run signal landing as a candidate.
 *
 * Never throws — every failure mode (main unreachable, no session, brain
 * offline, PHI-guard 422) is swallowed after this best-effort attempt, same
 * discipline as every other capture* call site in this repo.
 */
export async function reportRunMetric(verb, metric) {
  if (!metric || !metric.breach) return;
  const api = readApi();
  if (!api) return; // Breeze main not running — nothing to report to
  const taskId = (process.env.BREEZE_TYPEBUILD_TASK_ID || process.env.BREEZE_TASK_ID || '').trim();

  const body = summarize(verb, metric);
  const payload = {
    kind: 'memory',
    body,
    domain: metric.domain || undefined,
    task_id: taskId || undefined,
    evidence: {
      verb,
      breach: metric.breach,
      streak_count: metric.streakCount,
      streak_total_ms: metric.streakTotalMs,
    },
  };
  try {
    await fetch(`http://127.0.0.1:${api.port}/app/run-metric`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${api.token}` },
      body: JSON.stringify(payload),
    });
  } catch {
    /* fire-and-forget: never block/fail the run over a reporting miss */
  }
}

/** Human-readable, NON-PHI summary — this becomes the observation `body`, so
 *  it must contain only the verb, domain, and timing numbers (no selector
 *  text, no URL path/query, no typed values). */
function summarize(verb, metric) {
  const secs = (ms) => Math.round(ms / 100) / 10;
  const where = metric.domain ? ` on ${metric.domain}` : '';
  if (metric.breach === 'slow') {
    return `Browser step "${verb}"${where} took ${secs(metric.streakTotalMs || 0)}s in one call — slower than expected; worth checking for a faster path (API shortcut, saved tool, more direct selector) next time.`;
  }
  return `Browser step "${verb}"${where} was repeated ${metric.streakCount}x in a row (${secs(metric.streakTotalMs)}s total) before progressing — looks like a retry loop; a simpler/more direct path may exist.`;
}

/**
 * Report a SIMPLER PATH the agent found after a threshold breach (option-2 of
 * the task: "if the simpler path is found and works, commit it via
 * captureObservation/captureTool so it becomes the new default"). This is a
 * thin, explicit wrapper the agent's own follow-up `breeze-tools memory add`
 * / a future dedicated verb can call; kept here so the reporting shape
 * (control-API hop, NON-PHI fields only) stays in ONE place alongside
 * reportRunMetric. Not wired to a CLI verb yet — call sites can adopt it
 * incrementally without another round of cli.mjs surgery.
 */
export async function reportSimplerPath({ verb, domain, code, context }) {
  const api = readApi();
  if (!api) return;
  try {
    await fetch(`http://127.0.0.1:${api.port}/app/run-metric`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${api.token}` },
      body: JSON.stringify({
        kind: 'tool',
        proposeTool: true,
        code,
        context: context || `Faster path discovered after a "${verb}" slowdown${domain ? ` on ${domain}` : ''}.`,
        domain,
      }),
    });
  } catch {
    /* fire-and-forget */
  }
}

// Re-export so a caller only needs one import when it wants both the
// api.json path constant (rare) and the two functions above.
export { API_FILE };
