// task-b8306d2b85c2 — the task LIFECYCLE TIMELINE: a clean vertical trace of
// Created → Claimed → status transitions, folded from the per-task audit trail
// (the only place the server persists this history) plus the task's mapped
// lifecycle timestamps. Supersedes the old flat "History" list (fm-k6wz/S7).
//
// Shared by the detail PANEL and the detail DRAWER. Collapsed by default; on
// expand it lazily fetches the audit rows (GET /chromeext/audit — NON-PHI
// actor/action/detail/time) and renders them as a vertical timeline with a
// lane-colored node per event. The fold + claim-freshness math lives in the
// pure lifecycle.mjs helper (also unit-tested + reused by the row tooltip).
//
// PHI: audit actions/actors + timestamps are NON-PHI by design (the server
// never puts the body in `detail`). Memory-only — rows live in component state
// and are re-fetched on task change.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getTypebuildAudit } from '../../tasks';
import { buildTimeline, shortActor } from './lifecycle.mjs';
import type { TimelineEvent } from './lifecycle.mjs';
import { lastActivity, lastActivitySummary } from './vitals.mjs';
import type { Task, TaskAuditEvent } from '../../types';

// Coarse relative time from an ISO timestamp, with the absolute time as a
// tooltip. Falls back to the raw string when unparseable.
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

function absoluteTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

export function TaskTimeline({
  task,
  preloadedEvents,
}: {
  task: Task;
  // task-80be320f06b3 — the detail panel's vitals block already fetched the
  // audit; pass it in so we don't fetch twice. undefined = not provided (fetch
  // on expand as before); null/[] = provided-but-empty (don't fetch).
  preloadedEvents?: TaskAuditEvent[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TaskAuditEvent[] | null>(
    preloadedEvents ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const reqRef = useRef(0);
  const hasPreload = preloadedEvents !== undefined;

  // Collapse-reset on task change so a newly-selected task doesn't show the
  // prior task's trace.
  useEffect(() => {
    setOpen(false);
    setEvents(preloadedEvents ?? null);
    setError(false);
  }, [task.id, preloadedEvents]);

  const load = useCallback(() => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(false);
    void getTypebuildAudit(task.id, 30)
      .then((rows) => {
        if (reqRef.current === myReq) setEvents(rows);
      })
      .catch(() => {
        if (reqRef.current === myReq) {
          setEvents([]);
          setError(true);
        }
      })
      .finally(() => {
        if (reqRef.current === myReq) setLoading(false);
      });
  }, [task.id]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Only fetch on expand when nobody preloaded the audit for us.
    if (next && !hasPreload && events === null && !loading) load();
  };

  // task-80be320f06b3 — an ALWAYS-VISIBLE last-lifecycle line (even collapsed):
  // "Last: released by vivek · 6d ago". Derived from the same audit; '' when
  // none. lastActivitySummary already reads "<age> ago — <verb> by <who>"; flip
  // it to lead with the action for the compact one-liner.
  const la = lastActivity(events);
  const lastLine = (() => {
    const s = lastActivitySummary(la);
    if (!s) return '';
    const m = s.match(/^(.*? ago) — (.*)$/);
    return m ? `Last: ${m[2]} · ${m[1]}` : `Last: ${s}`;
  })();

  // Fold whatever audit we have (possibly empty) + the task's mapped fields
  // into the ordered timeline model. Even with no audit, the synthesized
  // Created/Claimed anchors give a minimal trace.
  const timeline: TimelineEvent[] = buildTimeline(events, {
    createdAtIso: task.createdAtIso ?? null,
    createdBy: task.createdBy ?? null,
    claimedAt: task.claimedAt ?? null,
    claimedBy: task.claimedBy ?? null,
  });

  return (
    <div className="tasks__detail-notes">
      <button
        type="button"
        className="tasks__detail-section tasks__history-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? '▾' : '▸'} Timeline
      </button>
      {/* task-80be320f06b3 — always-visible last-lifecycle line so the most
          recent event reads even when the timeline is collapsed. */}
      {!open && lastLine && (
        <div className="tasks__timeline-last">{lastLine}</div>
      )}
      {open && (
        <div className="tasks__timeline-wrap">
          {loading && <p className="tasks__detail-muted">Loading…</p>}
          {!loading && error && (
            <p className="tasks__detail-muted">
              Couldn’t load the timeline.{' '}
              <button type="button" className="tasks__history-retry" onClick={load}>
                Retry
              </button>
            </p>
          )}
          {!loading && !error && timeline.length === 0 && (
            <p className="tasks__detail-muted">No lifecycle events yet.</p>
          )}
          {!loading && !error && timeline.length > 0 && (
            <ol className="tasks__timeline">
              {timeline.map((e, i) => (
                <li
                  key={`${e.at}-${e.kind}-${i}`}
                  className={`tasks__tl-row tasks__tl-row--${e.kind}`}
                  title={e.detail || undefined}
                >
                  <span
                    className={`tasks__tl-node tasks__tl-node--${e.kind}`}
                    aria-hidden="true"
                  />
                  <div className="tasks__tl-main">
                    <div className="tasks__tl-head">
                      <span className="tasks__tl-label">{e.label}</span>
                      <span
                        className="tasks__tl-time"
                        title={absoluteTime(e.at)}
                      >
                        {relativeTime(e.at)}
                      </span>
                    </div>
                    {e.actor && (
                      <div className="tasks__tl-actor">
                        {shortActor(e.actor)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

export default TaskTimeline;
