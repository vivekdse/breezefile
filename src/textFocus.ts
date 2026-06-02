/**
 * Is the user currently typing into a text-entry surface?
 *
 * Used by global keyboard handlers (e.g. the `?` help/settings shortcut and
 * the file-list verb handler) so single-key shortcuts don't fire while the
 * user is editing text — in a search box, a rename field, the new-task form,
 * or the Milkdown markdown editor.
 *
 * We inspect both the event target and `document.activeElement`: usually they
 * agree, but a keydown can be retargeted (or land on a wrapper while focus
 * sits on a nested field), so checking both is more robust. Covers native
 * form controls plus any `contenteditable` surface (ProseMirror/Milkdown,
 * `role="textbox"`, etc.).
 */
export function isTextEntryTarget(e?: KeyboardEvent | null): boolean {
  const candidates: Array<EventTarget | null> = [
    e?.target ?? null,
    typeof document !== 'undefined' ? document.activeElement : null,
  ];
  for (const c of candidates) {
    const el = c as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') continue;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute?.('role') === 'textbox') return true;
    // The event may land on a child node inside an editable surface; walk up.
    if (typeof el.closest === 'function' && el.closest('[contenteditable="true"], [contenteditable=""]'))
      return true;
  }
  return false;
}
