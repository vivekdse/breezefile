import { useEffect, useState, type ReactNode } from 'react';
import { useStore, DEFAULT_KEYBINDS } from '../store';
import { fm, type Launcher } from '../bridge';
import { formatOpError } from '../errorMessages';
import { TypebuildAuthPanel } from './typebuild/TypebuildAuthPanel';
import { SideBySideSettings } from './typebuild/SideBySideSettings';
import {
  getEditableExts,
  addEditableExt,
  removeEditableExt,
  resetEditableExts,
  subscribeEditableExts,
  normalizeExt,
} from '../fileTypes';
import {
  getLauncherPrefs,
  setLauncherHidden,
  setDefaultLauncherId,
  resetLauncherPrefs,
  subscribeLauncherPrefs,
  isLauncherHidden,
  type LauncherPrefs,
} from '../launcherPrefs';
import './Settings.css';

type Props = { onClose: () => void; initialSection?: SectionId };

type SectionId =
  | 'keybindings'
  | 'editor'
  | 'task-management'
  | 'task-action-zone'
  | 'terminal'
  | 'chat-agent'
  | 'notifications'
  | 'claude-integration'
  | 'bookmarks'
  | 'typebuild';

export function Settings({ onClose, initialSection }: Props) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');
  // fm-2du: default-terminal selection. Source of truth lives in main
  // (userData/terminal.json), so we fetch on open and write back on change.
  const [defaultTerminal, setDefaultTerminal] = useState<string | null>(null);
  const [installedTerminals, setInstalledTerminals] = useState<string[]>([]);
  // fm-9iha — agent launchers for the "Default chat agent" picker.
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  // Single-open accordion. Keybindings opens by default since it's the
  // densest section and the most common reason to open Settings.
  const [openSection, setOpenSection] = useState<SectionId | null>(
    initialSection ?? 'keybindings',
  );
  // fm-at5 — inline result of the "Reset Claude integration" action.
  const [claudeResetMsg, setClaudeResetMsg] = useState<string | null>(null);
  const [claudeResetting, setClaudeResetting] = useState(false);
  // fm-o5z8 — editable-extension registry. Source of truth lives in
  // fileTypes.ts (localStorage-backed); we mirror it into local state and
  // subscribe so adds/removes here propagate to the file-open call sites.
  const [editableExts, setEditableExts] = useState<string[]>(() =>
    [...getEditableExts()].sort(),
  );
  const [extDraft, setExtDraft] = useState('');
  // fm-v3p — task-action-zone launcher prefs (per-launcher visibility +
  // default). Mirror into local state and subscribe so toggles reflect live.
  const [launcherPrefs, setLauncherPrefs] = useState<LauncherPrefs>(getLauncherPrefs);

  useEffect(() => {
    return subscribeEditableExts((next) => setEditableExts([...next].sort()));
  }, []);

  useEffect(() => subscribeLauncherPrefs(setLauncherPrefs), []);

  function addExt() {
    const norm = normalizeExt(extDraft);
    if (!norm) return;
    addEditableExt(norm);
    setExtDraft('');
  }

  async function resetClaudeIntegration() {
    if (claudeResetting) return;
    setClaudeResetting(true);
    setClaudeResetMsg(null);
    try {
      const hooks = await fm.claudeUnregisterHooks();
      if (hooks === 'error') {
        setClaudeResetMsg('Reset failed — see logs. Some entries may remain.');
      } else if (hooks === 'removed') {
        setClaudeResetMsg(
          'Removed TypeBuild hooks from ~/.claude. They re-register on next launch.',
        );
      } else {
        setClaudeResetMsg('Already clean — nothing of TypeBuild was registered.');
      }
    } catch (err) {
      setClaudeResetMsg(formatOpError('reset', err));
    } finally {
      setClaudeResetting(false);
    }
  }

  useEffect(() => {
    void fm.getDefaultTerminal().then(setDefaultTerminal).catch(() => {});
    void fm.listTerminals().then(setInstalledTerminals).catch(() => {});
    void fm.launchersList().then(setLaunchers).catch(() => {});
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
        msg: formatOpError('save', err),
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
            id="editor"
            title="Editor"
            isOpen={openSection === 'editor'}
            onToggle={() => toggle('editor')}
            extra={
              <button
                className="settings__reset"
                onClick={(e) => {
                  e.stopPropagation();
                  resetEditableExts();
                }}
              >
                Reset to defaults
              </button>
            }
          >
            <div className="settings__row">
              <span className="settings__path settings__hint">
                Files with these extensions open in Breeze's in-app editor on
                double-click (and via Open With → Breeze Editor). Anything not
                listed opens in your OS default app.
              </span>
            </div>
            <div className="settings__row">
              <input
                className="settings__input"
                value={extDraft}
                placeholder="add extension (e.g. md, txt, json)…"
                onChange={(e) => setExtDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExt();
                  }
                }}
              />
              <button
                className="settings__key"
                onClick={addExt}
                disabled={!normalizeExt(extDraft)}
              >
                Add
              </button>
            </div>
            <ul className="settings__list">
              {editableExts.length === 0 && (
                <li className="settings__empty">
                  No editable extensions — every file opens in the OS default
                  app.
                </li>
              )}
              {editableExts.map((ext) => (
                <li key={ext} className="settings__row">
                  <span className="settings__action">
                    <code>.{ext}</code>
                  </span>
                  <button
                    className="settings__key"
                    aria-label={`Remove .${ext}`}
                    onClick={() => removeEditableExt(ext)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
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
            id="task-action-zone"
            title="Task action zone"
            isOpen={openSection === 'task-action-zone'}
            onToggle={() => toggle('task-action-zone')}
            extra={
              (launcherPrefs.hidden.length > 0 ||
                launcherPrefs.defaultId !== null) && (
                <button
                  className="settings__reset"
                  onClick={(e) => {
                    e.stopPropagation();
                    resetLauncherPrefs();
                  }}
                >
                  Reset
                </button>
              )
            }
          >
            <div className="settings__row">
              <span className="settings__path settings__hint">
                Choose which launchers appear in a task's action zone, and which
                one is the <strong>default</strong> (shown as the primary
                action). Hidden launchers stay available everywhere else (the
                chip prompt, <kbd>:claude</kbd>/<kbd>:codex</kbd> verbs) — this
                only trims the task action zone.
              </span>
            </div>
            <ul className="settings__list">
              {launchers.filter((l) => l.id !== 'term').length === 0 && (
                <li className="settings__empty">
                  No launchers configured yet.
                </li>
              )}
              {launchers
                .filter((l) => l.id !== 'term')
                .map((l) => {
                  const hidden = isLauncherHidden(l.id, launcherPrefs);
                  const isDefault = launcherPrefs.defaultId === l.id;
                  return (
                    <li key={l.id} className="settings__row">
                      <span className="settings__action">
                        <label className="settings__inline-label">
                          <input
                            type="checkbox"
                            checked={!hidden}
                            onChange={(e) =>
                              setLauncherHidden(l.id, !e.target.checked)
                            }
                          />
                          <span>{l.label}</span>
                        </label>
                      </span>
                      <label
                        className="settings__inline-label"
                        title={
                          hidden
                            ? 'Make this the default (also shows it)'
                            : 'Make this the default action'
                        }
                      >
                        <input
                          type="radio"
                          name="task-action-zone-default"
                          checked={isDefault}
                          onChange={() => setDefaultLauncherId(l.id)}
                        />
                        <span>Default</span>
                      </label>
                    </li>
                  );
                })}
            </ul>
            <div className="settings__row">
              <label className="settings__inline-label">
                <input
                  type="radio"
                  name="task-action-zone-default"
                  checked={launcherPrefs.defaultId === null}
                  onChange={() => setDefaultLauncherId(null)}
                />
                <span>No default (show launchers in their normal order)</span>
              </label>
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
            id="chat-agent"
            title="Chat agent"
            isOpen={openSection === 'chat-agent'}
            onToggle={() => toggle('chat-agent')}
          >
            <div className="settings__row">
              <span className="settings__action">Default chat agent</span>
              <select
                className="settings__select"
                value={state.defaultAgentId ?? ''}
                onChange={(e) =>
                  dispatch({
                    type: 'setDefaultAgentId',
                    id: e.target.value || null,
                  })
                }
              >
                <option value="">— not set —</option>
                {launchers
                  .filter((l) => l.id !== 'term')
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
              </select>
            </div>
            <div className="settings__row">
              <span className="settings__path settings__hint">
                The agent the 💬 chat panel (<kbd>:chat</kbd>) launches for a
                folder or document. Agents come from your launchers config.
                While this is unset, opening a chat brings you here to choose
                one.
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
            {/* fm-h8g7 — task-notification verbosity. Distinct from the
                terminal-attention toggles above: covers agent run completions
                and remote TypeBuild task changes. */}
            <div className="settings__row">
              <span className="settings__action">
                Task notifications
                <small className="settings__hint" style={{ display: 'block' }}>
                  Agent runs and remote task changes
                </small>
              </span>
              <select
                value={state.taskNotifications}
                onChange={(e) =>
                  dispatch({
                    type: 'setTaskNotifications',
                    value: e.target.value as 'all' | 'failures' | 'off',
                  })
                }
              >
                <option value="all">All</option>
                <option value="failures">Failures only</option>
                <option value="off">Off</option>
              </select>
            </div>
            {/* fm-5xy — start-at / near-due reminders. On launch and daily at
                ~8am, a grouped notification for tasks coming into play today. */}
            <div className="settings__row">
              <span className="settings__action">
                Task start reminders
                <small className="settings__hint" style={{ display: 'block' }}>
                  Notify on launch and daily (~8am) when tasks start today
                </small>
              </span>
              <select
                value={state.taskReminders}
                onChange={(e) =>
                  dispatch({
                    type: 'setTaskReminders',
                    value: e.target.value as
                      | 'off'
                      | 'start'
                      | 'start-near-due',
                  })
                }
              >
                <option value="off">Off</option>
                <option value="start">Tasks starting today</option>
                <option value="start-near-due">
                  Starting today + due tomorrow
                </option>
              </select>
            </div>
          </AccordionSection>

          <AccordionSection
            id="claude-integration"
            title="Claude integration"
            isOpen={openSection === 'claude-integration'}
            onToggle={() => toggle('claude-integration')}
          >
            <div className="settings__row">
              <span className="settings__action">
                TypeBuild auto-registers a Claude Code MCP server and busy/idle
                hooks in <code>~/.claude</code> on launch. Reset to strip them
                (and the hook script); they re-register next launch.
              </span>
              <button
                className="settings__reset"
                disabled={claudeResetting}
                onClick={() => void resetClaudeIntegration()}
              >
                {claudeResetting ? 'Resetting…' : 'Reset Claude integration'}
              </button>
            </div>
            {claudeResetMsg && (
              <div className="settings__row">
                <span className="settings__path">{claudeResetMsg}</span>
              </div>
            )}
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

          <AccordionSection
            id="typebuild"
            title="TypeBuild"
            isOpen={openSection === 'typebuild'}
            onToggle={() => toggle('typebuild')}
          >
            <div className="settings__row">
              <span className="settings__action">
                <label className="settings__inline-label">
                  <input
                    type="checkbox"
                    checked={state.typebuildEnabled}
                    onChange={(e) =>
                      dispatch({
                        type: 'setTypebuildEnabled',
                        enabled: e.target.checked,
                      })
                    }
                  />
                  <span>Enable TypeBuild</span>
                </label>
              </span>
              <span className="settings__path settings__hint">
                Connect the TypeBuild task backend. Adds sign-in here, the
                onboarding checklist, side-by-side layout, and a sign-in
                indicator in the left sidebar. Leave off if you don't use
                TypeBuild.
              </span>
            </div>
            {state.typebuildEnabled && (
              <>
                <TypebuildAuthPanel />
                <SideBySideSettings />
              </>
            )}
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
