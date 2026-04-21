// Icon sprite — ported from design-assets/inspirations/themes.html (defs block).
// Rendered once at the app root (see <IconSprite />). Individual icons are
// rendered via <Icon name="..." /> which emits a <use href="#i-<name>" />.
//
// All icons share a 24x24 viewBox and use stroke="currentColor" / fill="none"
// (with a few filled accents) so they inherit color from the surrounding text.

export type IconName =
  | 'search'
  | 'home'
  | 'desktop'
  | 'docs'
  | 'download'
  | 'picture'
  | 'music'
  | 'movie'
  | 'drive'
  | 'usb'
  | 'folder'
  | 'image'
  | 'text'
  | 'sheet'
  | 'film'
  | 'drag'
  | 'open'
  | 'palette'
  | 'code'
  | 'archive'
  | 'app'
  | 'link'
  | 'file';

export const ICON_NAMES: readonly IconName[] = [
  'search',
  'home',
  'desktop',
  'docs',
  'download',
  'picture',
  'music',
  'movie',
  'drive',
  'usb',
  'folder',
  'image',
  'text',
  'sheet',
  'film',
  'drag',
  'open',
  'palette',
  'code',
  'archive',
  'app',
  'link',
  'file',
] as const;

export function IconSprite() {
  return (
    <svg
      width={0}
      height={0}
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      aria-hidden
      focusable={false}
    >
      <defs>
        <g id="i-search">
          <path
            d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm7 2-4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </g>
        <g id="i-home">
          <path
            d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-desktop">
          <rect x="3" y="5" width="18" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M9 21h6M12 17v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </g>
        <g id="i-docs">
          <path
            d="M5 6h10l4 4v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M15 6v4h4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M8 13h8M8 16h8M8 10h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <g id="i-download">
          <path
            d="M12 3v13m-5-5 5 5 5-5M4 21h16"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-picture">
          <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <circle cx="9" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
          <path
            d="m4 17 5-5 4 4 3-2 4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-music">
          <path
            d="M9 18V6l10-2v12"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <circle cx="6" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <circle cx="16" cy="16" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </g>
        <g id="i-movie">
          <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path
            d="M3 10h18M8 5v14M16 5v14M6 7.5h1M6 12h1M6 16.5h1M17 7.5h1M17 12h1M17 16.5h1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </g>
        <g id="i-drive">
          <path
            d="M3 13h18v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM5 13 8 5h8l3 8"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="17" r="0.8" fill="currentColor" />
          <circle cx="10" cy="17" r="0.8" fill="currentColor" />
        </g>
        <g id="i-usb">
          <path
            d="M12 3v18M8 7h8M10 11h4M8 15l4-2 4 2v4H8z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-folder">
          <path
            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-image">
          <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <circle cx="8" cy="10" r="1.4" fill="currentColor" />
          <path
            d="m3 17 6-5 5 4 3-2 4 3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-text">
          <path
            d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M15 3v4h4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M8 11h8M8 14h8M8 17h5M8 8h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <g id="i-sheet">
          <path
            d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M15 3v4h4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M8 11h9M8 15h9M11 9v12" stroke="currentColor" strokeWidth="1.3" />
        </g>
        <g id="i-film">
          <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path
            d="M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path
            d="m10 9 5 3-5 3z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-drag">
          <path
            d="M9 5v14M15 5v14M4 9h16M4 15h16"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </g>
        <g id="i-open">
          <path
            d="M15 3h6v6M10 14 21 3M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-palette">
          <path
            d="M12 3a9 9 0 1 0 0 18 2.5 2.5 0 0 0 2.5-2.5c0-.7-.3-1.3-.7-1.8a1.7 1.7 0 0 1 1.3-2.7H17a5 5 0 0 0 5-5C22 6 17.5 3 12 3z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <circle cx="7.5" cy="11" r="1.1" fill="currentColor" />
          <circle cx="11" cy="7" r="1.1" fill="currentColor" />
          <circle cx="16" cy="7.5" r="1.1" fill="currentColor" />
          <circle cx="18" cy="12" r="1.1" fill="currentColor" />
        </g>
        <g id="i-code">
          <path
            d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-archive">
          <rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path
            d="M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M10 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </g>
        <g id="i-app">
          <rect x="4" y="4" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="13" y="4" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="4" y="13" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="13" y="13" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </g>
        <g id="i-link">
          <path
            d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.5-1.5"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="i-file">
          <path
            d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M15 3v4h4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
        </g>
      </defs>
    </svg>
  );
}
