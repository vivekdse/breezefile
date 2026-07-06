// IconActionButton — the ONE compact icon-button used for row/header CRUD
// affordances (Edit / Archive / Delete) across New Home surfaces
// (task-5c8ca16e8e46). Replaces the oversized full-text nh__btn cluster that
// dominated the project hero and any other master-level action row. Glyph icons
// match the app's existing style (✎ edit, 🗄 archive, 🗑 delete — same family as
// the roster's ✎/🗑 glyphs). Always carries a title/aria-label so the meaning is
// never icon-only-ambiguous. Delete keeps the destructive accent via
// variant="danger".
//
// This is a SHARED component on purpose: every surface that needs the compact
// Edit/Archive/Delete row imports it rather than hand-mirroring the markup, so
// the parallel surfaces stay in lock-step. See CLAUDE.md "Unify, don't mirror".
import type { ReactNode } from 'react';

export type IconActionVariant = 'default' | 'danger';

export function IconActionButton({
  icon,
  label,
  onClick,
  disabled,
  variant = 'default',
}: {
  /** Glyph shown in the button (e.g. '✎', '🗄', '🗑'). */
  icon: ReactNode;
  /** Human-readable action name — used as the tooltip AND the accessible name. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: IconActionVariant;
}) {
  return (
    <button
      type="button"
      className={`nh__icon-btn${variant === 'danger' ? ' nh__icon-btn--danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
