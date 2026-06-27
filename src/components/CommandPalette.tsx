// ────────────────────────────────────────────────────────────────────────────
// fm-m7q — Cmd-K command palette.
//
// A non-typist affordance over the SAME verb registry that drives the ':'
// chip prompt, the native menu, and (in time) the help catalog. It does NOT
// fork execution: selecting a verb dispatches setMode{mode:'command', verb:id}
// — the exact path the native menu's onMenuVerb handler already uses. ChipPrompt
// then takes over: zero-slot verbs run immediately, multi-slot verbs land on
// their first option list so the user picks. So palette and ':' behave
// identically by construction.
//
// What the palette adds on top of the picker: it surfaces each verb's
// keybinding + category (the new VerbDef metadata) and orders by recency, so
// the catalog is browsable, not just searchable.
// ────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useOverlayExit } from '../useOverlayExit';
import { effectiveVerbsFor, useVerbCtx, type VerbDef } from './ChipPrompt';
import { rankPaletteVerbs } from '../verbPalette.mjs';
import type { PaletteVerb } from '../verbPalette.mjs';
import { loadVerbRecency, recordVerbUse } from '../verbRecency';
import { fm } from '../bridge';
import type { Launcher } from '../bridge';
import './CommandPalette.css';

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { state, dispatch, activeTab } = useStore();
  const { exit, state: exitState } = useOverlayExit(onClose);
  const ctx = useVerbCtx();
  const [filter, setFilter] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [recency, setRecency] = useState<string[]>(() => loadVerbRecency());
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const highlightedRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void fm.launchersList().then(setLaunchers).catch(() => {});
  }, []);

  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);

  // The verb set the active tab would offer in the ':' picker.
  const verbs: VerbDef[] = useMemo(
    () =>
      effectiveVerbsFor({
        tasksEnabled: state.taskManagementEnabled,
        tabKind: activeTab?.kind ?? 'folder',
        launchers,
      }),
    [state.taskManagementEnabled, activeTab?.kind, launchers],
  );

  // Project each VerbDef onto the lightweight palette row, computing
  // availability + description against the live context.
  const rows: PaletteVerb[] = useMemo(() => {
    return verbs.map((v) => {
      // task-57542e3435af — guard isAvailable as well as describe: one verb that
      // throws (a Ctx field undefined for the active tab) must not blank the
      // entire palette. Mirrors the same fix in ProjectsPage's quick-switcher.
      let avail: { ok: boolean; reason?: string } = { ok: true };
      try {
        if (ctx) avail = v.isAvailable(ctx);
      } catch {
        avail = { ok: true };
      }
      let description = '';
      try {
        description = ctx ? v.describe(ctx) : '';
      } catch {
        description = '';
      }
      return {
        id: v.id,
        label: v.label,
        aliases: v.aliases,
        category: v.category,
        description,
        available: avail.ok,
        keybinding: v.keybinding,
      };
    });
  }, [verbs, ctx]);

  const matches = useMemo(
    () => rankPaletteVerbs(rows, filter, recency),
    [rows, filter, recency],
  );

  useEffect(() => {
    if (highlightIdx >= matches.length) setHighlightIdx(0);
  }, [matches.length, highlightIdx]);

  function run(verbId: string) {
    setRecency(recordVerbUse(verbId));
    // Same path as the native menu (App.tsx onMenuVerb): hand the verb to
    // ChipPrompt, which owns slot collection + execution. Never forks.
    dispatch({ type: 'setMode', mode: 'command', verb: verbId });
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (filter) setFilter('');
      else exit();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const opt = matches[highlightIdx];
      if (opt && opt.available) run(opt.id);
      return;
    }
  }

  return (
    <div
      className="cmdk-overlay"
      data-state={exitState}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) exit();
      }}
    >
      <div className="cmdk-box" role="dialog" aria-label="Command palette">
        <div className="cmdk-input-row">
          <span className="cmdk-glyph" aria-hidden>
            ⌘K
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Run a command…  (type to filter)"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHighlightIdx(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="cmdk-list">
          {matches.length === 0 && (
            <li className="cmdk-empty">No commands match “{filter}”.</li>
          )}
          {matches.map((opt, i) => (
            <li
              key={opt.id}
              ref={i === highlightIdx ? highlightedRef : null}
              className={
                'cmdk-row' +
                (i === highlightIdx ? ' cmdk-row--highlighted' : '') +
                (opt.available ? '' : ' cmdk-row--disabled')
              }
              onMouseEnter={() => setHighlightIdx(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => opt.available && run(opt.id)}
              title={opt.available ? undefined : 'Not available right now'}
            >
              <span className="cmdk-row__main">
                <span className="cmdk-row__label">{opt.label}</span>
                {opt.description && (
                  <span className="cmdk-row__desc">{opt.description}</span>
                )}
              </span>
              <span className="cmdk-row__meta">
                {opt.category && (
                  <span className="cmdk-row__cat">{opt.category}</span>
                )}
                {opt.keybinding && (
                  <kbd className="cmdk-row__kbd">{opt.keybinding}</kbd>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
