/**
 * Motion utilities — DOM-level helpers for one-shot animations that
 * don't belong in a React render path.
 *
 * Kept in a tiny standalone module so command handlers (bulk rename /
 * trash / paste) can fire visual confirmation without importing
 * component internals.
 */

/**
 * Pulse the given filesystem paths with .row--celebrated so they read
 * as "something real happened". Each row runs gpDropSettle (scale-pop +
 * accent ring) once; the class is auto-removed after the animation
 * duration so subsequent celebrations can replay.
 *
 * fm-33l — call this from bulk-op completion paths in actions.ts /
 * App.tsx. No-op when no matching row is mounted (e.g. the entry was
 * scrolled off and unmounted by list virtualization).
 */
export function celebratePaths(paths: readonly string[]): void {
  if (typeof document === 'undefined') return;
  if (paths.length === 0) return;

  // Animation duration ≈ --dur-med (200ms) + jitter. Clear the class on
  // animationend so repeated calls replay the animation.
  for (const p of paths) {
    const row = document.querySelector<HTMLElement>(
      `.row[data-path="${escapeAttr(p)}"]`,
    );
    if (!row) continue;
    row.classList.remove('row--celebrated');
    // Force a reflow between removal and add so the browser restarts
    // the CSS animation even when the class was just removed.
    void row.offsetWidth;
    row.classList.add('row--celebrated');
    row.addEventListener(
      'animationend',
      () => row.classList.remove('row--celebrated'),
      { once: true },
    );
  }
}

function escapeAttr(s: string): string {
  // Fs paths contain no double-quotes on mac/linux; guard anyway so we
  // never inject into the selector string.
  return s.replace(/"/g, '\\"');
}
