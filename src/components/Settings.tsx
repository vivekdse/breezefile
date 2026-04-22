import { useEffect, useState } from 'react';
import { useStore, DEFAULT_KEYBINDS } from '../store';
import { fm } from '../bridge';
import './Settings.css';

type Props = { onClose: () => void };

export function Settings({ onClose }: Props) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');
  // fm-2du: default-terminal selection. Source of truth lives in main
  // (userData/terminal.json), so we fetch on open and write back on change.
  const [defaultTerminal, setDefaultTerminal] = useState<string | null>(null);
  const [installedTerminals, setInstalledTerminals] = useState<string[]>([]);

  useEffect(() => {
    void fm.getDefaultTerminal().then(setDefaultTerminal).catch(() => {});
    void fm.listTerminals().then(setInstalledTerminals).catch(() => {});
  }, []);

  async function onTerminalChange(value: string) {
    // Empty string is our sentinel for "Ask every time" — clears the pref.
    const next = value === '' ? null : value;
    setDefaultTerminal(next);
    try {
      await fm.setDefaultTerminal(next);
      dispatch({
        type: 'setStatus',
        msg: next
          ? `default terminal: ${next.replace(/\.app$/, '')}`
          : 'terminal: ask every time',
      });
    } catch (err) {
      // Non-fatal: the UI state already reflects intent.
      dispatch({
        type: 'setStatus',
        msg: `save failed: ${(err as Error).message}`,
      });
    }
  }

  // Group bindings by namespace prefix (nav.*, goto.*, etc.) for ranger-style layout.
  const grouped: Record<string, [string, string][]> = {};
  for (const [action, key] of Object.entries(state.keybinds)) {
    const group = action.includes('.') ? action.split('.')[0] : 'misc';
    (grouped[group] ||= []).push([action, key]);
  }
  const groupOrder = [
    'nav',
    'goto',
    'find',
    'mark',
    'yank',
    'cut',
    'paste',
    'trash',
    'rename',
    'sort',
    'view',
    'tab',
    'bookmark',
    'tag',
    'misc',
    'filter',
    'command',
    'shell',
    'hidden',
    'theme',
    'mkdir',
    'touch',
    'reveal',
    'refresh',
    'delete',
    'bulkRename',
    'quit',
    'settings',
  ].filter((g) => grouped[g]);

  function startEdit(action: string) {
    setEditing(action);
    setDraftKey('');
  }

  function saveEdit() {
    if (editing && draftKey) {
      dispatch({
        type: 'setKeybinds',
        keybinds: { ...state.keybinds, [editing]: draftKey },
      });
    }
    setEditing(null);
    setDraftKey('');
  }

  function resetAll() {
    dispatch({ type: 'setKeybinds', keybinds: { ...DEFAULT_KEYBINDS } });
  }

  return (
    <div className="settings" onClick={onClose}>
      <div className="settings__panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings__head">
          <h2 className="settings__title">Settings</h2>
          <button className="settings__close" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings__section">
          <div className="settings__section-head">
            <h3 className="settings__section-title">Keybindings</h3>
            <button className="settings__reset" onClick={resetAll}>
              Reset to defaults
            </button>
          </div>
          {groupOrder.map((g) => (
            <div key={g} className="settings__group">
              <div className="settings__group-title">{g}</div>
              <ul className="settings__list">
                {grouped[g]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([action, key]) => (
                    <li key={action} className="settings__row">
                      <span className="settings__action">{action}</span>
                      {editing === action ? (
                        <input
                          autoFocus
                          className="settings__input"
                          value={draftKey}
                          placeholder="press keys…"
                          onChange={(e) => setDraftKey(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            else if (e.key === 'Escape') {
                              setEditing(null);
                              setDraftKey('');
                            }
                          }}
                          onBlur={saveEdit}
                        />
                      ) : (
                        <button className="settings__key" onClick={() => startEdit(action)}>
                          <kbd>{key}</kbd>
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>

        <section className="settings__section">
          <h3 className="settings__section-title">Default terminal</h3>
          <div className="settings__row">
            <span className="settings__action">Open Terminal here launches</span>
            <select
              className="settings__select"
              value={defaultTerminal ?? ''}
              onChange={(e) => void onTerminalChange(e.target.value)}
            >
              <option value="">Ask every time</option>
              {installedTerminals.map((bundle) => (
                <option key={bundle} value={bundle}>
                  {bundle.replace(/\.app$/, '')}
                </option>
              ))}
              {defaultTerminal && !installedTerminals.includes(defaultTerminal) && (
                <option value={defaultTerminal}>
                  {defaultTerminal.replace(/\.app$/, '')} (not detected)
                </option>
              )}
            </select>
          </div>
          {installedTerminals.length === 0 && (
            <div className="settings__empty">
              No supported terminals detected in /Applications.
            </div>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__section-title">Bookmarks</h3>
          <ul className="settings__list">
            {Object.entries(state.bookmarks).length === 0 && (
              <li className="settings__empty">
                No bookmarks yet. Press <kbd>m</kbd> then a letter on a folder to bind.
              </li>
            )}
            {Object.entries(state.bookmarks).map(([key, path]) => (
              <li key={key} className="settings__row">
                <span className="settings__action">
                  <kbd>{key}</kbd>
                </span>
                <span className="settings__path">{path}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
