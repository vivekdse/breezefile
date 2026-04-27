import { useState } from 'react';
import { useStore } from '../store';
import { basename } from '../actions';
import { fm } from '../bridge';
import {
  currentDragPaths,
  currentDragSourceCwd,
  dropIntoFolder,
  endAppDrag,
  hasAppDrag,
} from '../dragState';
import './Tabbar.css';

export function Tabbar() {
  const { state, dispatch, activeTab, refreshActive } = useStore();
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const onNewTab = () => {
    const cwd = activeTab?.trail[activeTab.trail.length - 1];
    if (!cwd) return;
    dispatch({
      type: 'newTab',
      tab: {
        id: crypto.randomUUID(),
        kind: 'folder',
        taskId: null,
        trail: [cwd],
        selected: { 0: 0 },
        marks: {},
        sortKey: 'name',
        sortReverse: false,
        showHidden: false,
        viewMode: 'list',
        filter: '',
        tagViz: [],
        tagFilter: { mode: 'off', ids: [] },
        history: [],
        forward: [],
      },
    });
  };

  const onTabDragOver = (idx: number) => (e: React.DragEvent) => {
    if (!hasAppDrag()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    setDropIdx(idx);
  };
  const onTabDragLeave = () => setDropIdx(null);
  const onTabDrop = (idx: number) => async (e: React.DragEvent) => {
    e.preventDefault();
    setDropIdx(null);
    const paths = currentDragPaths();
    const srcCwd = currentDragSourceCwd();
    endAppDrag();
    const tab = state.tabs[idx];
    if (!tab || paths.length === 0) return;
    const target = tab.trail[tab.trail.length - 1];
    const msg = await dropIntoFolder(paths, target, srcCwd, e.altKey, fm).catch(
      (err) => `drop failed: ${(err as Error).message}`,
    );
    if (msg) dispatch({ type: 'setStatus', msg });
    await refreshActive();
  };

  return (
    <div className="tabbar">
      {state.tabs.map((t, i) => {
        const cwd = t.trail[t.trail.length - 1];
        const label = basename(cwd) || '/';
        const active = i === state.activeTab;
        const canClose = state.tabs.length > 1;
        const isDropTarget = dropIdx === i;
        return (
          <button
            key={t.id}
            className={`tabbar__tab ${active ? 'tabbar__tab--active' : ''} ${isDropTarget ? 'tabbar__tab--drop' : ''}`}
            onClick={() => dispatch({ type: 'selectTab', index: i })}
            onDragOver={onTabDragOver(i)}
            onDragLeave={onTabDragLeave}
            onDrop={onTabDrop(i)}
            title={
              t.terminal?.attention
                ? `${cwd} · terminal needs attention`
                : cwd
            }
          >
            <span className="tabbar__label">{label}</span>
            {/* fm-fux — attention badge. Backgrounded tabs whose terminal
                emitted a cursor-show / BEL / OSC9 since we last saw them
                paint a small dot; bell pulses, idle is a steady accent. */}
            {t.terminal?.attention && (
              <span
                className={`tabbar__attn tabbar__attn--${t.terminal.attention}`}
                aria-label="terminal needs attention"
              />
            )}
            {canClose && (
              <span
                className="tabbar__close"
                onClick={(e) => {
                  e.stopPropagation();
                  // fm-jtu — kill the embedded terminal's pty before the
                  // tab disappears, otherwise the shell stays alive in
                  // the main process until window close.
                  if (t.terminal) {
                    void fm.termKill(t.terminal.ptyId).catch(() => {});
                  }
                  dispatch({ type: 'closeTab', index: i });
                }}
              >
                ×
              </span>
            )}
          </button>
        );
      })}
      <button
        className="tabbar__new"
        onClick={onNewTab}
        title="New tab at current folder"
        aria-label="New tab"
      >
        +
      </button>
    </div>
  );
}
