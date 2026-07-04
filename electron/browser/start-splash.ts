// The themed "task starting" splash shown in the operator page view BEFORE the
// agent issues its first real navigation (task-3a49fb5adf24). Replaces the old
// `https://example.com` placeholder, which was meaningless — example.com was
// just a fast-loading default the CDP page view showed until the agent's first
// `goto`. Now we show a calm, themed splash that tells the human "your task is
// starting in a moment" with a gentle animation.
//
// Why a self-contained `data:` URL instead of a bundled asset that @imports
// tokens.css: the page view is a separate, preload-less WebContentsView, and a
// `data:` document cannot resolve a relative `@import` to the renderer bundle.
// So we inline a SMALL palette table (just the ~5 colors the splash uses) that
// mirrors the per-theme blocks in src/styles/tokens.css. The splash sits ON the
// panel surface, so it uses panel-appropriate text (--panel-ink / --panel-muted
// equivalents) — this matters for `plum`, whose --panel is dark while its --ink
// is tuned for the light canvas.
//
// KEEP IN SYNC with src/styles/tokens.css: if a theme's --panel / --ink /
// --muted / --accent / --rule changes (or a theme is added/removed), update the
// matching row here. The set of themes is the Theme union in src/theme.ts.

/** The theme ids, mirroring the `Theme` union in src/theme.ts. */
export type SplashTheme =
  | 'paper'
  | 'pastel'
  | 'peony'
  | 'clay'
  | 'moss'
  | 'linen'
  | 'rose'
  | 'dawn'
  | 'plum'
  | 'dusk';

export const SPLASH_DEFAULT_THEME: SplashTheme = 'dusk';

interface SplashPalette {
  /** Surface the splash card sits on (--panel). */
  panel: string;
  /** Window backdrop behind the card (--bg). */
  bg: string;
  /** Primary text on the panel (--panel-ink ?? --ink). */
  ink: string;
  /** Secondary/caption text on the panel (--panel-muted ?? --muted). */
  muted: string;
  /** Accent — drives the animated ring (--accent). */
  accent: string;
}

// Derived from src/styles/tokens.css :root[data-theme='<id>'] blocks. For plum
// the ink/muted come from its --panel-ink / --panel-muted overrides (dark
// panel), not its canvas --ink. See the file header note.
const PALETTES: Record<SplashTheme, SplashPalette> = {
  paper:  { panel: '#fbf6ea', bg: '#ebe3ce', ink: '#1c1814', muted: '#857c6b', accent: '#a3391a' },
  pastel: { panel: '#fef8f6', bg: '#f1dfd9', ink: '#1f1418', muted: '#715b61', accent: '#8a3347' },
  peony:  { panel: '#f9f5f8', bg: '#e7dde4', ink: '#1c1422', muted: '#665870', accent: '#932a55' },
  clay:   { panel: '#fef6f4', bg: '#f0cfcb', ink: '#1c0f14', muted: '#77555c', accent: '#7a1f2f' },
  moss:   { panel: '#fcf1ed', bg: '#f2d9cf', ink: '#1e2a22', muted: '#6e7f72', accent: '#2f5a3e' },
  linen:  { panel: '#f1ecdf', bg: '#dcd5c0', ink: '#26241e', muted: '#5d5848', accent: '#4c5840' },
  rose:   { panel: '#fbf4f4', bg: '#ecd9da', ink: '#1d1315', muted: '#69545a', accent: '#883a3f' },
  dawn:   { panel: '#faf2f2', bg: '#ecdfe3', ink: '#2b2032', muted: '#8a757f', accent: '#9c3a20' },
  plum:   { panel: '#2a1a30', bg: '#faeff2', ink: '#f1ddea', muted: '#b098ac', accent: '#e06aac' },
  dusk:   { panel: '#2b2032', bg: '#150d1c', ink: '#f1e4e8', muted: '#9a8b94', accent: '#f4b09a' },
};

/** Normalize an arbitrary string to a known theme, falling back to default. */
export function resolveSplashTheme(theme: string | undefined): SplashTheme {
  return theme && theme in PALETTES
    ? (theme as SplashTheme)
    : SPLASH_DEFAULT_THEME;
}

/** True if `url` is one of our splash data URLs (so callers can tell whether
 *  the page view is still on the splash vs. a real page the agent navigated
 *  to). We tag the document with a sentinel comment to make this robust. */
export function isSplashUrl(url: string | undefined): boolean {
  return !!url && url.startsWith('data:text/html') && url.includes(SPLASH_SENTINEL);
}

// A stable marker we embed in the HTML (and thus the data: URL) so isSplashUrl
// can recognize our own splash regardless of theme.
const SPLASH_SENTINEL = 'breeze-operator-splash';

// task-8997b15a37d9 — the splash must reflect REAL state, not spin forever.
// `done: true` renders a static (no spinner, no pulsing glow) "session
// finished, no browser used" card, shown when the agent's session ends
// without ever issuing a real `goto` (see markSessionEnded in window.ts).
// Same palette/layout as the starting card so the swap reads as a state
// change, not a different screen.
function splashHtml(theme: SplashTheme, done = false): string {
  const p = PALETTES[theme];
  // Fonts mirror tokens.css --font-serif / --font-sans heads, degrading to
  // system fonts (the page view has no access to the bundled webfonts).
  return `<!doctype html>
<html lang="en" data-theme="${theme}" class="${SPLASH_SENTINEL}${done ? ' breeze-operator-splash--done' : ''}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${done ? 'Task finished' : 'Starting your task…'}</title>
<style>
  :root {
    --panel: ${p.panel};
    --bg: ${p.bg};
    --ink: ${p.ink};
    --muted: ${p.muted};
    --accent: ${p.accent};
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--ink);
    font-family: 'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 22px;
    padding: 48px 56px;
    border-radius: 16px;
    background: var(--panel);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 18px 50px rgba(0,0,0,0.10);
    animation: rise 520ms cubic-bezier(0.2, 0, 0, 1.05) both;
  }
  /* The animation: a dual ring — an outer track plus a sweeping accent arc —
     with a soft pulsing glow behind it. Calm, not frantic. */
  .ring {
    position: relative;
    width: 56px;
    height: 56px;
  }
  .ring::before {
    /* soft accent glow that breathes */
    content: '';
    position: absolute;
    inset: -8px;
    border-radius: 50%;
    background: radial-gradient(circle, var(--accent) 0%, transparent 68%);
    opacity: 0.16;
    animation: breathe 2.4s ease-in-out infinite;
  }
  .spinner {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 3px solid color-mix(in srgb, var(--muted) 28%, transparent);
    border-top-color: var(--accent);
    animation: spin 0.95s cubic-bezier(0.5, 0.1, 0.4, 0.9) infinite;
  }
  .title {
    font-family: 'Fraunces', 'Iowan Old Style', Georgia, serif;
    font-size: 21px;
    font-weight: 540;
    letter-spacing: -0.01em;
    margin: 0;
  }
  .sub {
    font-size: 13.5px;
    color: var(--muted);
    margin: 0;
    text-align: center;
    max-width: 26ch;
    line-height: 1.5;
  }
  .dots::after {
    content: '';
    animation: dots 1.6s steps(4, end) infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe {
    0%, 100% { opacity: 0.10; transform: scale(0.96); }
    50%      { opacity: 0.22; transform: scale(1.04); }
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
  }
  @keyframes dots {
    0%   { content: ''; }
    25%  { content: '·'; }
    50%  { content: '··'; }
    75%  { content: '···'; }
    100% { content: ''; }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 2s; }
    .ring::before, .card, .dots::after { animation: none; }
  }
  /* Done state: static check mark, no spinner/glow/dots. */
  .check {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    font-size: 26px;
    line-height: 1;
  }
</style>
</head>
<body>
  <main class="card" role="status" aria-live="polite">
    ${
      done
        ? `<div class="check" aria-hidden="true">&#10003;</div>
    <h1 class="title">Task finished</h1>
    <p class="sub">This session didn't use the browser.</p>`
        : `<div class="ring"><div class="spinner"></div></div>
    <h1 class="title">Starting your task<span class="dots"></span></h1>
    <p class="sub">Setting up the browser. This will begin in just a moment.</p>`
    }
  </main>
</body>
</html>`;
}

/** Build the `data:text/html` URL for the themed start splash. Pass
 *  `done: true` for the static post-session variant (task-8997b15a37d9) shown
 *  when the agent's session ended without the agent ever navigating the
 *  browser — see markSessionEnded in window.ts. */
export function splashDataUrl(theme: string | undefined, done = false): string {
  const resolved = resolveSplashTheme(theme);
  // encodeURIComponent keeps the data URL valid (the HTML has #, quotes, etc.).
  return `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(resolved, done))}`;
}

// The meaningless placeholder the browser surface USED to land on before the
// agent's first real `goto` (task-3a49fb5adf24 / task-d85d23f3aea4). It must
// NEVER be loaded on task start — empty/missing or a stale example.com start_url
// both resolve to the themed splash instead. Matches example.com / .org / .net
// (optionally www, http(s), trailing slash) since those are the IANA reserved
// "use in examples" domains that show up as placeholder start_urls.
const EXAMPLE_PLACEHOLDER_RE = /^https?:\/\/(www\.)?example\.(com|org|net)\/?$/i;

/** True if `url` is the meaningless example.com-style placeholder. These must be
 *  treated as "no start url" → splash, never actually loaded. */
export function isPlaceholderStartUrl(url: string | undefined | null): boolean {
  return !!url && EXAMPLE_PLACEHOLDER_RE.test(url.trim());
}

/** THE single chokepoint for picking the browser surface's start URL. An empty,
 *  missing, or example.com-placeholder url yields the themed splash (in `theme`,
 *  default theme when omitted); any real url passes through (trimmed) unchanged.
 *  Use this everywhere a start/initial URL is seeded so example.com can never
 *  load on task start. */
export function resolveStartUrl(
  url: string | undefined | null,
  theme?: string | undefined,
): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed || isPlaceholderStartUrl(trimmed)) return splashDataUrl(theme);
  return trimmed;
}

/** Start URL for a GENERAL, human-opened browser tab (Ctrl+B) — one with no
 *  task and no agent about to navigate. Here the "starting your task" splash is
 *  wrong, so an empty/missing (or example.com-placeholder) url resolves to a
 *  plain blank new-tab page instead of the splash. A real url still passes
 *  through (trimmed). Distinct from resolveStartUrl, which is for the
 *  task/operator session that DOES wait on the agent's first navigation. */
export function resolveGeneralStartUrl(url: string | undefined | null): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed || isPlaceholderStartUrl(trimmed)) return 'about:blank';
  return trimmed;
}
