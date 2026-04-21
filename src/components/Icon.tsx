// <Icon name="folder" size={18} /> — thin wrapper around the shared sprite.
// The actual path data lives in ./icons.tsx (mounted once via <IconSprite />
// at the app root). Icons inherit color from surrounding text via
// stroke="currentColor".

import type { IconName } from './icons';

export type { IconName } from './icons';

export interface IconProps {
  name: IconName;
  /** Pixel size for width/height. Defaults to 18 (matches themes.html .row .ico). */
  size?: number;
  className?: string;
  /** Optional override — otherwise icon is marked aria-hidden. */
  title?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 18, className, title, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable={false}
    >
      {title ? <title>{title}</title> : null}
      <use href={`#i-${name}`} />
    </svg>
  );
}
