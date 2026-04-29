import { useEffect, useState, type ReactNode } from 'react';
import { useStore, DEFAULT_KEYBINDS } from '../store';
import { fm } from '../bridge';
import './Settings.css';

type Props = { onClose: () => void };

type SectionId =
  | 'keybindings'
  | 'task-management'
  | 'terminal'
  | 'notifications'
  | 'bookmarks';

export function Settings({ onClose }: Props) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');
  // fm-2du: default-terminal selection. Source of truth lives in main
  // (userData/terminal.json), so we fetch on open and write back on change.
  const [defaultTerminal, setDefaultTerminal] = useState<string | null>(null);
  const [installedTerminals, setInstalledTerminals] = useState<string[]>([]);
  // Single-open accordion. Keybindings opens by default since it's the
  // densest section and the most common reason to open Settings.
  const [openSection, setOpenSection] = useState<SectionId | null>(
    'keybindings',
  );

  useEffect(() => {
    void fm.getDefaultTerminal().then(setDefaultTerminal).catch(() => {});
    void fm.listTerminals().then(setInstalledTerminals).catch(() => {});
  }, []);

  // ESC closes — also handled by the chip prompt's overlay manager elsewhere,
  // but Settings is mounted directly by App so it owns its own escape hatch.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onTerminalChange(value: string) {
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
      dispatch({
        type: 'setStatus',
        msg: `save failed: ${(err as Error).message}`,
      });
    }
  }

  // Group keybindings by namespace prefix (nav.*, goto.*, etc.).
  const grouped: Record<string, [string, string][]> = {};
  for (const [action, key] of Object.entries(state.keybinds)) {
    const group = action.includes('.') ? action.split('.')[0] : 'misc';
    (grouped[group] ||= []).push([action, key]);
  }
  const groupOrder = [
    'nav', 'goto', 'find', 'mark', 'yank', 'cut', 'paste', 'trash',
    'rename', 'sort', 'view', 'tab', 'bookmark', 'tag', 'misc', 'filter',
    'command', 'shell', 'hidden', 'theme', 'mkdir', 'touch', 'reveal',
    'refresh', 'delete', 'bulkRename', 'quit', 'settings',
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

  function toggle(id: SectionId) {
    setOpenSection((cur) => (cur === id ? null : id));
  }

  return (
    <div
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
    >
      <div className="settings__panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings__head">
          <h2 className="settings__title" id="settings-title">Settings</h2>
          <button
            className="settings__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <div className="settings__body">
          <AccordionSection
            id="keybindings"
            title="Keybindings"
            isOpen={openSection === 'keybindings'}
            onToggle={() => toggle('keybindings')}
            extra={
              <button
                className="settings__reset"
                onClick={(e) => {
                  e.stopPropagation();
                  resetAll();
                }}
              >
                Reset to defaults
              </button>
            }
          >
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
                          <button
                            className="settings__key"
                            onClick={() => startEdit(action)}
                          >
                            <kbd>{key}</kbd>
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </AccordionSection>

          <AccordionSection
            id="task-management"
            title="Task management"
            isOpen={openSection === 'task-management'}
            onToggle={() => toggle('task-management')}
          >
            <div className="settings__row">
              <span className="settings__action">
                <label className="settings__inline-label">
                  <input
                    type="checkbox"
                    checked={state.taskManagementEnabled}
                    onChange={(e) =>
                      dispatch({
                        type: 'setTaskManagementEnabled',
                        enabled: e.target.checked,
                      })
                    }
                  />
                  <span>Enable task management</span>
                </label>
              </span>
              <span className="settings__path settings__hint">
                Folder-anchored to-dos with optional AI-agent integration.
                Adds the Active Tasks sidebar section, <kbd>:task</kbd> /{' '}
                <kbd>:tasks</kbd> verbs, and launchers that pass task context
                to Claude / Codex / Gemini.
              </span>
            </div>
          </AccordionSection>

          <AccordionSection
            id="terminal"
            title="Terminal"
            isOpen={openSection === 'terminal'}
            onToggle={() => toggle('terminal')}
          >
            <div className="settings__row">
              <span className="settings__action">
                Open Terminal here launches
              </span>
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
                {defaultTerminal &&
                  !installedTerminals.includes(defaultTerminal) && (
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
            <div className="settings__row">
              <span className="settings__action">
                <label className="settings__inline-label">
                  <input
                    type="checkbox"
                    checked={state.useTmux}
                    onChange={(e) =>
                      dispatch({ type: 'setUseTmux', value: e.target.checked })
                    }
                  />
                  <span>Use tmux for embedded terminals</span>
                </label>
              </span>
              <span className="settings__path settings__hint">
                Wrap each tab's terminal in a tmux session named after the tab
                label. Two tabs with the same label share one session, and a
                session survives closing/reopening the terminal in that tab.
                Requires <code>tmux</code> on PATH (
                <code>brew install tmux</code>).
              </span>
            </div>
          </AccordionSection>

          <AccordionSection
            id="notifications"
            title="Notifications"
            isOpen={openSection === 'notifications'}
            onToggle={() => toggle('notifications')}
          >
            <div className="settings__row">
              <span className="settings__action">
                System notification when a backgrounded tab needs attention
              </span>
              <input
                type="checkbox"
                checked={state.notifyOnAttention}
                onChange={(e) =>
                  dispatch({
                    type: 'setNotifyOnAttention',
                    value: e.target.checked,
                  })
                }
              />
            </div>
            <div className="settings__row">
              <span className="settings__action">
                Play sound with attention notifications
              </span>
              <input
                type="checkbox"
                checked={state.soundOnAttention}
                onChange={(e) =>
                  dispatch({
                    type: 'setSoundOnAttention',
                    value: e.target.checked,
                  })
                }
              />
            </div>
          </AccordionSection>

          <AccordionSection
            id="bookmarks"
            title="Bookmarks"
            isOpen={openSection === 'bookmarks'}
            onToggle={() => toggle('bookmarks')}
          >
            <ul className="settings__list">
              {Object.entries(state.bookmarks).length === 0 && (
                <li className="settings__empty">
                  No bookmarks yet. Press <kbd>m</kbd> then a letter on a
                  folder to bind.
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
          </AccordionSection>
        </div>
      </div>
    </div>
  );
}

function AccordionSection({
  id,
  title,
  isOpen,
  onToggle,
  extra,
  children,
}: {
  id: string;
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`settings__section ${isOpen ? 'settings__section--open' : ''}`}
    >
      <div className="settings__section-head">
        <button
          type="button"
          className="settings__section-toggle"
          aria-expanded={isOpen}
          aria-controls={`settings-section-${id}`}
          onClick={onToggle}
        >
          <span className="settings__section-chevron" aria-hidden="true">
            {isOpen ? '▾' : '▸'}
          </span>
          <h3 className="settings__section-title">{title}</h3>
        </button>
        {extra && <span className="settings__section-extra">{extra}</span>}
      </div>
      {isOpen && (
        <div
          id={`settings-section-${id}`}
          className="settings__section-body"
          role="region"
          aria-label={title}
        >
          {children}
        </div>
      )}
    </section>
  );
}
