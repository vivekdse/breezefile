import { useEffect, useState } from 'react';
import { OverlayCtx, type OverlayApi, type RenameMode } from './overlays';
import { Titlebar } from './components/Titlebar';
import { Pathbar } from './components/Pathbar';
import { FolderList } from './components/FolderList';
import { FolderHeader } from './components/FolderHeader';
import { FilterChip } from './components/FilterChip';
import { Preview } from './components/Preview';
import { TagInspector } from './components/TagInspector';
import { TagPicker } from './components/TagPicker';
import { Sidebar } from './components/Sidebar';
import { Statusbar } from './components/Statusbar';
import { Tabbar } from './components/Tabbar';
import { ModeLine } from './components/ModeLine';
import { Settings } from './components/Settings';
import { ChipPrompt } from './components/ChipPrompt';
import { PasteChip } from './components/PasteChip';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { ThemePicker } from './components/ThemePicker';
import { Welcome, shouldShowWelcome } from './components/Welcome';
import { UpdateChip } from './components/UpdateChip';
import { PrivacyHelpDialog } from './components/PrivacyHelpDialog';
import { OpenWithDialog } from './components/OpenWithDialog';
import { Tutorial } from './components/Tutorial';
import { HelpTour } from './components/HelpTour';
import { TerminalSplit } from './components/TerminalSplit';
import { TipsChip, isTipsEnabled, setTipsEnabled } from './components/TipsChip';
import { IconSprite } from './components/icons';
import { StoreProvider, useStore } from './store';
import { useKeyboard } from './useKeyboard';
import { fm } from './bridge';
import { basename, currentEntry, dirname, lastCol, pathJoin, visibleEntries } from './actions';
import { celebratePaths } from './motion-utils';
import { useOverlayExit } from './useOverlayExit';
import type { CustomTagCriterion, Entry } from './types';
import { TAG_PALETTE, assignTagKey, newTagId } from './tags';
import './App.css';


function Shell() {
  const { state, activeTab, refreshActive, dispatch, setTab, focusEntryByName } = useStore();
  const [renaming, setRenaming] = useState<{ entry: Entry; mode: RenameMode } | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState<boolean>(() => shouldShowWelcome());
  const [privacyHelpOpen, setPrivacyHelpOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialNonce, setTutorialNonce] = useState(0);
  // fm-294 — global confirm dialog. Surfaces request a confirm by
  // dispatching `fm:confirm` with a ConfirmRequest payload.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // fm-pg0 — Open With surface. The chip verb dispatches `fm:openWith`
  // with the target path; we run the native app picker here, then mount
  // OpenWithDialog so the user can confirm + optionally bind the app as
  // the default for this extension. Null when no flow is active.
  const [openWith, setOpenWith] = useState<{ path: string; ext?: string; appPath: string } | null>(
    null,
  );
  // fm-60k — Create-tag overlay. Opened via the 'newtag' verb or the
  // "+ New tag" button in the TagInspector pane.
  const [newTagOpen, setNewTagOpen] = useState(false);
  // fm-60k — keyboard tag HUD. Opened via `t` (apply) or `T` (filter).
  const [tagPicker, setTagPicker] = useState<'apply' | 'filter' | null>(null);
  // Slide-based help (HelpTour). Opened by the :help verb or the Help
  // link in the Statusbar. Distinct from Tutorial (interactive practice).
  const [helpOpen, setHelpOpen] = useState(false);

  useKeyboard(
    (entry, mode) => setRenaming({ entry, mode }),
    () => setMkdirOpen(true),
    () => setQuickFindOpen(true),
    () => setShellOpen(true),
  );

  // fm-fux — global terminal attention monitor. Every backgrounded tab's
  // pty keeps streaming data (it's alive in the main process) but no
  // <Terminal> component is mounted while the tab is inactive. We tap the
  // raw IPC stream to detect attention markers (cursor-visibility for
  // generation→idle transitions, BEL/OSC for explicit pings) and update
  // the badge on the corresponding tab. The active tab's <Terminal> also
  // reports attention but always clears it, so dispatch from here is gated
  // on `tabIndex !== state.activeTab`.
  useEffect(() => {
    const off = fm.onTermData((id, data) => {
      const idx = state.tabs.findIndex((t) => t.terminal?.ptyId === id);
      if (idx < 0 || idx === state.activeTab) return;
      let next: 'idle' | 'busy' | 'bell' | null | undefined;
      if (data.includes('\x07') || data.includes('\x1b]9;')) next = 'bell';
      else if (data.includes('\x1b[?25h')) next = 'idle';
      else if (data.includes('\x1b[?25l')) next = 'busy';
      if (next === undefined) return;
      const cur = state.tabs[idx].terminal?.attention ?? null;
      // Bell sticks until user focuses the tab; never let a later 'busy'
      // signal silence a still-unattended bell.
      if (cur === 'bell' && next !== 'bell') return;
      if (cur === next) return;
      dispatch({ type: 'setTerminalAttention', tabIndex: idx, attention: next });
    });
    return off;
  }, [state.tabs, state.activeTab, dispatch]);

  // fm-fux — when a tab with a pending attention badge becomes active,
  // clear the badge. This handles "user just looked at it" without
  // requiring the Terminal component to remount in time. (The Terminal's
  // own isActive effect also clears, but switching to a tab whose
  // terminal is currently scrolled-back-but-visible needs the clear here
  // too, before the xterm parses any new data.)
  useEffect(() => {
    const t = state.tabs[state.activeTab];
    if (t?.terminal?.attention) {
      dispatch({
        type: 'setTerminalAttention',
        tabIndex: state.activeTab,
        attention: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTab]);

  // Self-heal the permissionsPrimed flag on every launch so the Welcome
  // notice only appears when something is actually needed. primePermissions
  // is silent for already-granted folders (opendir succeeds without
  // re-prompting), so this is a no-op when the OS already has all grants.
  // If localStorage was wiped between launches but TCC still has them,
  // we restore the flag without ever showing the notice. Truly first-time
  // users (no grants yet) hit the existing Welcome flow as before, since
  // primePermissions returns 'denied' or pending and the flag stays unset.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('fm.permissionsPrimed') === '1') return;
    void fm.primePermissions().then((res) => {
      const needsAction = Object.values(res).some(
        (s) => s !== 'granted' && s !== 'missing',
      );
      if (!needsAction) {
        try { localStorage.setItem('fm.permissionsPrimed', '1'); } catch { /* noop */ }
      }
    }).catch(() => { /* noop */ });
  }, []);

  useEffect(() => {
    function h(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Bridge events from ChipPrompt → the overlays owned by App
  useEffect(() => {
    function onRename(e: Event) {
      const path = (e as CustomEvent).detail?.path as string | undefined;
      if (!path || !activeTab) return;
      const cwd = activeTab.trail[activeTab.trail.length - 1];
      const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
      const entry = entries.find((ent) => ent.path === path);
      if (entry) setRenaming({ entry, mode: 'full' });
    }
    function onMkdir() {
      setMkdirOpen(true);
    }
    function onTouch() {
      setTouchOpen(true);
    }
    function onTheme() {
      setThemeOpen(true);
    }
    function onPrivacyHelp() {
      setPrivacyHelpOpen(true);
    }
    function onTutorial() {
      // Always start from step 1 when explicitly opened — picking it up
      // mid-flow on a new launch is fine, but a re-launch via the verb
      // means the user wants to take it again.
      try {
        localStorage.removeItem('fm.tutorial.step');
        localStorage.removeItem('fm.tutorial.done');
      } catch {
        /* noop */
      }
      setTutorialOpen(true);
      setTutorialNonce((n) => n + 1);
    }
    function onToggleTips() {
      const next = !isTipsEnabled();
      setTipsEnabled(next);
      dispatch({
        type: 'setStatus',
        msg: next ? 'tips on' : 'tips off — type tips to bring them back',
      });
    }
    function onConfirm(e: Event) {
      const detail = (e as CustomEvent).detail as ConfirmRequest | undefined;
      if (detail) setConfirm(detail);
    }
    function onNewTag() {
      setNewTagOpen(true);
    }
    function onTagPicker(e: Event) {
      const detail = (e as CustomEvent).detail as { mode: 'apply' | 'filter' } | undefined;
      setTagPicker(detail?.mode ?? 'apply');
    }
    function onHelp() {
      setHelpOpen(true);
    }
    function onWelcome() {
      setWelcomeOpen(true);
    }
    async function onOpenWith(e: Event) {
      const detail = (e as CustomEvent).detail as { path: string; ext?: string } | undefined;
      if (!detail?.path) return;
      try {
        const picked = await fm.pickApplication();
        if (picked) setOpenWith({ path: detail.path, ext: detail.ext, appPath: picked });
      } catch (err) {
        dispatch({
          type: 'setStatus',
          msg: `open with failed: ${(err as Error).message}`,
        });
      }
    }
    window.addEventListener('fm:openRename', onRename);
    window.addEventListener('fm:openMkdir', onMkdir);
    window.addEventListener('fm:openTouch', onTouch);
    window.addEventListener('fm:openTheme', onTheme);
    window.addEventListener('fm:openPrivacyHelp', onPrivacyHelp);
    window.addEventListener('fm:openTutorial', onTutorial);
    window.addEventListener('fm:toggleTips', onToggleTips);
    window.addEventListener('fm:confirm', onConfirm);
    window.addEventListener('fm:openWith', onOpenWith);
    window.addEventListener('fm:newTag', onNewTag);
    window.addEventListener('fm:tagPicker', onTagPicker);
    window.addEventListener('fm:openHelp', onHelp);
    window.addEventListener('fm:openWelcome', onWelcome);
    return () => {
      window.removeEventListener('fm:openRename', onRename);
      window.removeEventListener('fm:openMkdir', onMkdir);
      window.removeEventListener('fm:openTouch', onTouch);
      window.removeEventListener('fm:openTheme', onTheme);
      window.removeEventListener('fm:openPrivacyHelp', onPrivacyHelp);
      window.removeEventListener('fm:openTutorial', onTutorial);
      window.removeEventListener('fm:toggleTips', onToggleTips);
      window.removeEventListener('fm:confirm', onConfirm);
      window.removeEventListener('fm:openWith', onOpenWith);
      window.removeEventListener('fm:newTag', onNewTag);
      window.removeEventListener('fm:tagPicker', onTagPicker);
      window.removeEventListener('fm:openHelp', onHelp);
      window.removeEventListener('fm:openWelcome', onWelcome);
    };
  }, [activeTab, state.entriesByPath]);

  if (!activeTab) {
    return <div className="app">loading…</div>;
  }
  const tab = activeTab;

  const overlayApi: OverlayApi = {
    requestRename: (entry, mode = 'full') => setRenaming({ entry, mode }),
    requestMkdir: () => setMkdirOpen(true),
  };

  return (
    <OverlayCtx.Provider value={overlayApi}><div
      className="shell"
      data-view={tab.viewMode}
      data-mode={tab.terminal ? 'terminal' : 'files'}
    >
      <IconSprite />
      {/* title slot — owned by fm-9w0 */}
      <div className="shell__title">
        <Titlebar />
      </div>
      {/* chrome slot — Tabbar + Pathbar stack */}
      <div className="shell__chrome">
        <Tabbar />
        <Pathbar
          path={tab.trail[tab.trail.length - 1]}
          onNavigate={(p) => setTab({ trail: [p], selected: { 0: 0 } })}
        />
      </div>
      {/* side slot — Sidebar (fm-4zi) fills the reserved 240px slot.
          Hidden in preview mode (fm-wq6) so the preview pane can claim
          the real estate. Hidden in terminal mode (fm-jtu) so the
          terminal goes full-bleed. */}
      {tab.viewMode !== 'preview' && !tab.terminal && <Sidebar />}
      {/* main slot — the recessed plate. FolderList (single-list Finder-style
          view per fm-ehb) fills it. MillerColumns remains in the tree for a
          future optional view mode. */}
      <main className="shell__main">
        <TerminalSplit
          tab={tab}
          tabIndex={state.activeTab}
          isActive={true}
        >
          <FolderHeader />
          <FilterChip />
          <FolderList />
        </TerminalSplit>
      </main>
      {/* preview slot — Preview (fm-fda) fills the reserved 340px slot.
          In tag view (fm-uns) the slot hosts TagInspector instead, so the
          user can browse, toggle, and combine tags without leaving the file
          list. Hidden in terminal mode (fm-jtu). */}
      {!tab.terminal && (
        tab.viewMode === 'tag' ? <TagInspector /> : <Preview />
      )}
      {/* status slot — ModeLine stacked above Statusbar. Hidden in
          terminal mode so the terminal pane reaches the bottom edge. */}
      {!tab.terminal && (
        <div className="shell__status">
          <ModeLine />
          <Statusbar />
        </div>
      )}

      {/* Floating paste affordance (fm-3km) — visible whenever the user has
          staged files via Copy / Move verbs or yy / dd chords. Renders above
          the main content but below modals. */}
      <PasteChip />

      {/* Update available — fetches GitHub Releases on a 24h cadence and
          shows a quiet bottom-left pill when a newer version is out.
          User upgrades via `brew upgrade --cask breezefile` (copy button). */}
      <UpdateChip />

      {/* Rotating "did you know" tips in the bottom-right. Helps first-
          time users discover the verb prompt without an in-your-face
          tutorial. Dismissible forever. */}
      <TipsChip />

      {renaming && (
        <RenameOverlay
          entry={renaming.entry}
          mode={renaming.mode}
          onClose={() => setRenaming(null)}
          onCommit={async (newName) => {
            if (!newName || newName === renaming.entry.name) {
              setRenaming(null);
              return;
            }
            const to = pathJoin(dirname(renaming.entry.path), newName);
            // Let the overlay surface errors inline — rethrow so it stays
            // open and the user can fix the name without retyping.
            await fm.rename(renaming.entry.path, to);
            await refreshActive();
            requestAnimationFrame(() => celebratePaths([to]));
            dispatch({ type: 'setStatus', msg: `renamed → ${newName}` });
            setRenaming(null);
          }}
        />
      )}

      {mkdirOpen && (
        <MkdirOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setMkdirOpen(false)}
          onCommit={async (name) => {
            if (!name) { setMkdirOpen(false); return; }
            await fm.mkdir(pathJoin(tab.trail[tab.trail.length - 1], name));
            await refreshActive();
            focusEntryByName(name);
            dispatch({ type: 'setStatus', msg: `created ${name}/` });
            setMkdirOpen(false);
          }}
        />
      )}

      {touchOpen && (
        <TouchOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setTouchOpen(false)}
          onCommit={async (name) => {
            if (!name) { setTouchOpen(false); return; }
            const to = pathJoin(tab.trail[tab.trail.length - 1], name);
            await fm.touch(to);
            await refreshActive();
            focusEntryByName(name);
            requestAnimationFrame(() => celebratePaths([to]));
            dispatch({ type: 'setStatus', msg: `created ${name}` });
            setTouchOpen(false);
          }}
        />
      )}

      {quickFindOpen && (
        <QuickFindOverlay
          onClose={() => setQuickFindOpen(false)}
        />
      )}

      {shellOpen && (
        <ShellOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setShellOpen(false)}
        />
      )}

      {state.mode === 'command' && (
        <ChipPrompt
          initialFilter={state.modeBuffer}
          initialVerbId={state.modeVerb}
          onClose={() => dispatch({ type: 'setMode', mode: 'normal' })}
        />
      )}
      {themeOpen && <ThemePicker onClose={() => setThemeOpen(false)} />}
      {welcomeOpen && <Welcome onClose={() => setWelcomeOpen(false)} />}
      {privacyHelpOpen && <PrivacyHelpDialog onClose={() => setPrivacyHelpOpen(false)} />}
      {tutorialOpen && (
        <Tutorial key={tutorialNonce} onClose={() => setTutorialOpen(false)} />
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {confirm && (
        <ConfirmDialog
          {...confirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {openWith && (
        <OpenWithDialog
          filePath={openWith.path}
          ext={openWith.ext}
          appPath={openWith.appPath}
          onClose={() => setOpenWith(null)}
        />
      )}
      {newTagOpen && (
        <CreateTagOverlay
          onClose={() => setNewTagOpen(false)}
          onCommit={(name, color, criterion) => {
            const id = newTagId(name);
            const taken = new Set<string>();
            for (const t of state.customTags) if (t.key) taken.add(t.key);
            const key = assignTagKey(name, taken);
            dispatch({
              type: 'createCustomTag',
              tag: { id, name: name.trim(), color, criterion, key, createdAt: Date.now() },
            });
            dispatch({ type: 'addTagViz', id });
            dispatch({
              type: 'setStatus',
              msg: `tag created: ${name}${key ? ` (key: ${key})` : ''}`,
            });
            setNewTagOpen(false);
          }}
        />
      )}
      {tagPicker && (
        <TagPicker mode={tagPicker} onClose={() => setTagPicker(null)} />
      )}
      {helpOpen && <HelpTour onClose={() => setHelpOpen(false)} />}
    </div>
    </OverlayCtx.Provider>
  );
}

type CriterionField =
  | 'manual'
  | 'extIn'
  | 'sizeOver'
  | 'sizeUnder'
  | 'modifiedWithin'
  | 'modifiedBefore'
  | 'nameContains'
  | 'nameMatches'
  | 'kindIs';

const CRITERION_LABELS: Record<CriterionField, string> = {
  manual: 'No rule — apply manually',
  extIn: 'Extension is one of…',
  sizeOver: 'Size larger than…',
  sizeUnder: 'Size smaller than…',
  modifiedWithin: 'Modified within…',
  modifiedBefore: 'Modified more than…',
  nameContains: 'Name contains…',
  nameMatches: 'Name matches regex…',
  kindIs: 'Kind is…',
};

function CreateTagOverlay({
  onClose,
  onCommit,
}: {
  onClose: () => void;
  onCommit: (name: string, color: string, criterion?: CustomTagCriterion) => void;
}) {
  const [name, setName] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  const [field, setField] = useState<CriterionField>('extIn');
  // One generic value buffer per field type; we read whatever's relevant
  // for the chosen field at submit time. Separate state to avoid stomping
  // on the user's typed values when they switch field momentarily.
  const [extValue, setExtValue] = useState('');
  const [sizeValue, setSizeValue] = useState('');
  const [daysValue, setDaysValue] = useState('');
  const [textValue, setTextValue] = useState('');
  const [kindValue, setKindValue] = useState<'dir' | 'file'>('file');
  const { exit, state } = useOverlayExit(onClose);

  function buildCriterion(): CustomTagCriterion | undefined {
    switch (field) {
      case 'manual':
        return undefined;
      case 'extIn': {
        const values = extValue
          .split(/[,\s]+/)
          .map((v) => v.trim().toLowerCase().replace(/^\./, ''))
          .filter(Boolean);
        return values.length > 0 ? { field: 'extIn', values } : undefined;
      }
      case 'sizeOver': {
        const mb = Number(sizeValue);
        return Number.isFinite(mb) && mb > 0 ? { field: 'sizeOver', mb } : undefined;
      }
      case 'sizeUnder': {
        const mb = Number(sizeValue);
        return Number.isFinite(mb) && mb > 0 ? { field: 'sizeUnder', mb } : undefined;
      }
      case 'modifiedWithin': {
        const days = Number(daysValue);
        return Number.isFinite(days) && days > 0 ? { field: 'modifiedWithin', days } : undefined;
      }
      case 'modifiedBefore': {
        const days = Number(daysValue);
        return Number.isFinite(days) && days > 0 ? { field: 'modifiedBefore', days } : undefined;
      }
      case 'nameContains':
        return textValue.trim() ? { field: 'nameContains', text: textValue.trim() } : undefined;
      case 'nameMatches':
        return textValue.trim() ? { field: 'nameMatches', pattern: textValue.trim() } : undefined;
      case 'kindIs':
        return { field: 'kindIs', value: kindValue };
    }
  }

  const submit = () => {
    if (!name.trim()) return;
    const crit = buildCriterion();
    if (field !== 'manual' && !crit) return; // need a value for non-manual rules
    onCommit(name, TAG_PALETTE[colorIdx].color, crit);
  };

  const valueInput = (() => {
    switch (field) {
      case 'manual':
        return (
          <div className="tagform__hint-line">
            Files won't be tagged automatically. Use <kbd>tag</kbd> to add them.
          </div>
        );
      case 'extIn':
        return (
          <input
            className="overlay__input"
            value={extValue}
            placeholder="pdf, jpg, mov"
            onChange={(e) => setExtValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        );
      case 'sizeOver':
      case 'sizeUnder':
        return (
          <div className="tagform__row">
            <input
              className="overlay__input tagform__num"
              type="number"
              min={0}
              step="0.1"
              value={sizeValue}
              placeholder="4"
              onChange={(e) => setSizeValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <span className="tagform__unit">MB</span>
          </div>
        );
      case 'modifiedWithin':
      case 'modifiedBefore':
        return (
          <div className="tagform__row">
            <input
              className="overlay__input tagform__num"
              type="number"
              min={0}
              step="1"
              value={daysValue}
              placeholder="7"
              onChange={(e) => setDaysValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <span className="tagform__unit">days</span>
          </div>
        );
      case 'nameContains':
        return (
          <input
            className="overlay__input"
            value={textValue}
            placeholder="screenshot"
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        );
      case 'nameMatches':
        return (
          <input
            className="overlay__input"
            value={textValue}
            placeholder="^IMG_\\d+"
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        );
      case 'kindIs':
        return (
          <div className="tagform__row" role="radiogroup" aria-label="Kind">
            <button
              type="button"
              role="radio"
              aria-checked={kindValue === 'file'}
              className={`tagform__pill${kindValue === 'file' ? ' tagform__pill--on' : ''}`}
              onClick={() => setKindValue('file')}
            >
              File
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kindValue === 'dir'}
              className={`tagform__pill${kindValue === 'dir' ? ' tagform__pill--on' : ''}`}
              onClick={() => setKindValue('dir')}
            >
              Folder
            </button>
          </div>
        );
    }
  })();

  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box overlay__box--tag" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New tag</div>
        <input
          autoFocus
          className="overlay__input"
          value={name}
          placeholder="e.g. heavy-pdfs, this-week, screenshots"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        <div className="overlay__palette" role="radiogroup" aria-label="Tag color">
          {TAG_PALETTE.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={colorIdx === i}
              aria-label={c.name}
              className={[
                'overlay__swatch',
                colorIdx === i && 'overlay__swatch--on',
              ].filter(Boolean).join(' ')}
              style={{ background: c.color }}
              onClick={() => setColorIdx(i)}
              title={c.name}
            />
          ))}
        </div>

        <div className="overlay__label tagform__divider">Rule</div>
        <select
          className="overlay__input tagform__select"
          value={field}
          onChange={(e) => setField(e.target.value as CriterionField)}
        >
          {(Object.keys(CRITERION_LABELS) as CriterionField[]).map((f) => (
            <option key={f} value={f}>
              {CRITERION_LABELS[f]}
            </option>
          ))}
        </select>
        {valueInput}

        <div className="overlay__hint">
          Combine tags with <b>Match all</b> / <b>Match any</b> in the inspector to
          build complex filters. Enter to create · Esc to cancel.
        </div>
      </div>
    </div>
  );
}

function RenameOverlay({
  entry,
  mode,
  onClose,
  onCommit,
}: {
  entry: Entry;
  mode: RenameMode;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const label =
    mode === 'append'
      ? 'Append to name'
      : mode === 'prepend'
        ? 'Prepend to name'
        : mode === 'beforeExt'
          ? 'Rename (keep extension)'
          : 'Rename';
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">{label}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
          onFocus={(e) => {
            const el = e.currentTarget;
            const n = value;
            const dot = n.lastIndexOf('.');
            const hasExt = dot > 0 && entry.kind !== 'dir';
            if (mode === 'append') {
              el.setSelectionRange(n.length, n.length);
            } else if (mode === 'prepend') {
              el.setSelectionRange(0, 0);
            } else if (mode === 'beforeExt' && hasExt) {
              el.setSelectionRange(dot, dot);
            } else if (hasExt) {
              el.setSelectionRange(0, dot);
            } else {
              el.select();
            }
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function MkdirOverlay({
  cwd,
  onClose,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New folder in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function TouchOverlay({
  cwd,
  onClose,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New file in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          placeholder="untitled.txt"
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function QuickFindOverlay({ onClose }: { onClose: () => void }) {
  const { state, activeTab, setTab, dispatch } = useStore();
  const [value, setValue] = useState('');
  const { exit, state: overlayState } = useOverlayExit(onClose);
  if (!activeTab) return null;
  const tab = activeTab;

  function doFind(q: string) {
    const path = tab.trail[lastCol(tab)];
    const entries = visibleEntries(state.entriesByPath[path], tab);
    const needle = q.toLowerCase();
    const idx = entries.findIndex((e) => e.name.toLowerCase().includes(needle));
    if (idx >= 0) {
      setTab({ selected: { ...tab.selected, [lastCol(tab)]: idx } });
    }
    dispatch({ type: 'setLastFind', query: q });
  }

  return (
    <div className="overlay" data-state={overlayState} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">Quick find</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            doFind(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // open the currently-selected entry
              const entries = visibleEntries(state.entriesByPath[tab.trail[lastCol(tab)]], tab);
              const entry = currentEntry(tab, entries);
              if (entry) {
                if (entry.kind === 'dir') {
                  setTab({
                    trail: [...tab.trail, entry.path],
                    selected: { ...tab.selected, [tab.trail.length]: 0 },
                  });
                } else {
                  fm.open(entry.path);
                }
              }
              exit();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
      </div>
    </div>
  );
}

function ShellOverlay({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { dispatch } = useStore();
  const [value, setValue] = useState('');
  const { exit, state } = useOverlayExit(onClose);
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">shell in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="echo hi"
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              try {
                await fm.runCommand(cwd, value);
                dispatch({ type: 'setStatus', msg: `$ ${value}` });
              } catch (err) {
                dispatch({
                  type: 'setStatus',
                  msg: `shell failed: ${(err as Error).message}`,
                });
              }
              exit();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
      </div>
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
