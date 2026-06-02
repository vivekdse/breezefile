import { useEffect, useRef, useState } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { useStore } from '../store';
import { fm } from '../bridge';
import { basename, dirname } from '../actions';
import { humanizeError } from '../errorMessages';
import { isDefaultNoteName, notesDirFor } from './ChipPrompt';
import type { Tab } from '../types';
import './EditShell.css';

// fm-notes — derive a filename from a markdown heading. Keep ASCII
// letters/digits/dot/dash/underscore; collapse the rest to single dashes.
// Cap at a generous length so titles like "Thoughts on the Q3 roadmap"
// land as readable filenames without a renderer surprise.
function slugifyHeading(heading: string): string {
  const trimmed = heading.replace(/^#+\s*/, '').trim();
  if (!trimmed) return '';
  const slug = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return slug;
}

// Pull the first markdown heading (`# ...`, `## ...`, …) at the top of
// the file. Stops at the first non-empty non-heading line so the body
// content can't be mistaken for a title.
function firstHeading(md: string): string {
  const lines = md.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return m ? m[1] : '';
  }
  return '';
}

/**
 * fm-vu55 — editor shell for an `edit`-kind tab. Routes by extension:
 * `.md` / `.mdx` get Milkdown (WYSIWYM with HTML elements styled by the
 * app theme), everything else gets a monospaced plain-text editor.
 *
 * Dirty tracking lives on the tab (state.tabs[i].dirty). ⌘S / Ctrl+S
 * saves atomically through `fm.editorSave`, which writes via tmp-file
 * + rename and refuses to clobber a file modified on disk since open.
 */
/**
 * Persistent edit-tab layer, mirroring TerminalSplit (fm-jtu). We mount an
 * EditShell for *every* edit-kind tab and only show the active one, so
 * switching back into a note doesn't re-read the file + rebuild Milkdown
 * from scratch — that cold start was the seconds-long "can't type" lag.
 * Backgrounded editors stay warm and never grab focus.
 */
export function EditSplit({
  tabs,
  activeIndex,
}: {
  tabs: Tab[];
  activeIndex: number;
}) {
  const activeIsEdit = tabs[activeIndex]?.kind === 'edit';
  return (
    <div
      className="edit-fullbleed"
      style={{
        display: activeIsEdit ? 'flex' : 'none',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
      }}
    >
      {tabs.map((t, i) => {
        if (t.kind !== 'edit') return null;
        const isActive = i === activeIndex;
        return (
          <div
            key={t.id}
            style={{
              display: isActive ? 'flex' : 'none',
              flexDirection: 'column',
              flex: '1 1 auto',
              minHeight: 0,
            }}
          >
            <EditShell tabIndex={i} isActive={isActive} />
          </div>
        );
      })}
    </div>
  );
}

export function EditShell({
  tabIndex,
  isActive = true,
}: {
  tabIndex: number;
  /** Edit tabs stay mounted across switches (fm-jtu-style persistence) so
   *  the Milkdown editor isn't torn down + rebuilt on every switch — that
   *  cold start was the multi-second "can't type yet" lag. Only the active
   *  tab is visible and grabs focus; background editors stay warm and quiet. */
  isActive?: boolean;
}) {
  const { state, dispatch } = useStore();
  const tab = state.tabs[tabIndex];
  const filePath = tab?.editPath ?? '';
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const isMd = ext === 'md' || ext === 'mdx';

  const [loaded, setLoaded] = useState(false);
  // The child editor (Milkdown view or textarea) registers a focus fn here
  // so we can re-focus it when this tab becomes active without remounting.
  const editorFocusRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `seed` is the value handed to the editor. It changes ONLY on a real
  // file (re)load — never on save — so a save doesn't remount Crepe or
  // re-seed the textarea (which would lose cursor + undo history).
  const [seed, setSeed] = useState('');
  // Baseline for dirty comparison. A ref (not state) so updating it on
  // save doesn't trigger a re-render / editor remount.
  const baselineRef = useRef('');
  // Mutable buffers — current editor contents (kept in a ref so save
  // doesn't re-render). mtimeRef is the last known on-disk mtime; we
  // pass it to saveFile so an external edit between open and save is
  // flagged rather than silently overwritten.
  const contentRef = useRef('');
  const mtimeRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  // Debounce handle for autosave — saves ~800ms after the last keystroke
  // so we don't thrash the disk on every character, but feel "live".
  const autosaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // fm-notes — when we rename a default-named note based on its first
  // heading, tab.editPath changes; the load effect would otherwise re-read
  // the file and remount the editor (losing the user's cursor mid-type).
  // This flag lets the rename skip that single reload.
  const skipNextOpenRef = useRef(false);
  const [homedir, setHomedir] = useState('');
  useEffect(() => {
    void fm.homedir().then(setHomedir).catch(() => {});
  }, []);

  // Load file contents on mount / when path changes.
  useEffect(() => {
    if (!filePath) return;
    if (skipNextOpenRef.current) {
      skipNextOpenRef.current = false;
      return;
    }
    let cancelled = false;
    setLoaded(false);
    setError(null);
    void fm.editorOpen(filePath).then((res) => {
      if (cancelled) return;
      if (res.error) {
        setError(res.error);
        setLoaded(true);
        return;
      }
      contentRef.current = res.content;
      mtimeRef.current = res.mtimeMs;
      baselineRef.current = res.content;
      setSeed(res.content);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // When this persisted tab becomes active (or finishes loading while
  // active), pull keyboard focus into its editor. rAF lets the display
  // toggle commit first so focus lands on a visible surface.
  useEffect(() => {
    if (!isActive || !loaded) return;
    const id = requestAnimationFrame(() => editorFocusRef.current?.());
    return () => cancelAnimationFrame(id);
  }, [isActive, loaded, seed]);

  const markDirty = (dirty: boolean) => {
    if (dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    dispatch({ type: 'setTabDirty', index: tabIndex, dirty });
  };

  const onChange = (next: string) => {
    contentRef.current = next;
    const dirty = next !== baselineRef.current;
    markDirty(dirty);
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    if (dirty) {
      autosaveRef.current = setTimeout(() => {
        void doSave();
      }, 800);
    }
  };

  const doSave = async () => {
    if (!filePath || saving) return;
    if (autosaveRef.current) {
      clearTimeout(autosaveRef.current);
      autosaveRef.current = null;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fm.editorSave(filePath, contentRef.current, mtimeRef.current);
      if (res.error) {
        setStatusMsg(`save failed: ${res.error}`);
        return;
      }
      if (res.conflict) {
        setStatusMsg('file changed on disk — reopen to reconcile');
        return;
      }
      mtimeRef.current = res.mtimeMs;
      baselineRef.current = contentRef.current;
      markDirty(false);
      setStatusMsg('saved');
      // Clear the "saved" toast after a beat so it doesn't linger.
      setTimeout(() => setStatusMsg((m) => (m === 'saved' ? null : m)), 1500);
      // fm-notes — if this is a default-named note in the breeze notes
      // folder and the user has typed a `# heading` at the top, promote
      // the heading to the filename. Once the file is named anything
      // other than YYYY-MM-DD-N.md (either by the heading rename or by
      // the user typing a name later), this short-circuits and leaves
      // the filename alone — so a manual rename always wins.
      if (isMd && homedir) {
        const notesDir = notesDirFor(homedir);
        const name = basename(filePath);
        // Only consider a heading-rename once the user has moved off the
        // first line. The seed content is `# \n` (a single newline after
        // the empty heading), so we require something past that — either
        // body text or an additional blank line the user navigated to.
        // Without this, the file would rename on the first character the
        // user types into the title, which feels jumpy.
        const movedPastTitle = /[^\n]\n[^\n]|[^\n]\n\n/.test(contentRef.current);
        if (
          movedPastTitle &&
          dirname(filePath) === notesDir &&
          isDefaultNoteName(name)
        ) {
          const heading = firstHeading(contentRef.current);
          const slug = slugifyHeading(heading);
          if (slug) {
            // Collision safety: never silently overwrite an existing note
            // with the same title. Probe with fm.stat and walk a `-2`,
            // `-3`… suffix until we find a free name (or give up after a
            // reasonable bound and leave the date-named file alone).
            let newPath = `${notesDir}/${slug}.md`;
            let attempt = 1;
            while (attempt < 50) {
              const candidate =
                attempt === 1
                  ? `${notesDir}/${slug}.md`
                  : `${notesDir}/${slug}-${attempt}.md`;
              try {
                await fm.stat(candidate);
                // Exists — try the next suffix.
                attempt++;
                continue;
              } catch {
                newPath = candidate;
                break;
              }
            }
            if (newPath !== filePath && attempt < 50) {
              try {
                await fm.rename(filePath, newPath);
                try {
                  const st = await fm.stat(newPath);
                  mtimeRef.current = st.mtimeMs;
                } catch { /* ignore */ }
                skipNextOpenRef.current = true;
                dispatch({
                  type: 'updateTab',
                  index: tabIndex,
                  patch: { editPath: newPath },
                });
              } catch {
                // Race (someone created the candidate between stat and
                // rename) — leave the date-named file in place; the user
                // can rename manually.
              }
            }
          }
        }
      }
    } catch (err) {
      setStatusMsg(`save failed: ${humanizeError(err).message}`);
    } finally {
      setSaving(false);
    }
  };

  // Flush pending autosave on unmount / path change so we don't lose
  // the last few keystrokes if the user closes the tab quickly.
  useEffect(() => {
    return () => {
      if (autosaveRef.current) {
        clearTimeout(autosaveRef.current);
        autosaveRef.current = null;
        if (dirtyRef.current) void doSave();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // ⌘S / Ctrl+S to save, scoped to this tab being active. The `isActive`
  // guard matters now that every edit tab stays mounted (fm-jtu-style
  // persistence) — without it a single ⌘S would save *all* open editors.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // doSave is stable enough — its inputs come from refs and component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, saving, isActive]);

  // fm-xpk7 — chip-prompt editor verbs (:save / :revert / :close) target the
  // active edit tab via window events. Only the active EditShell responds, so
  // no per-tab addressing is needed.
  useEffect(() => {
    if (!isActive) return;
    const onSave = () => void doSave();
    const reread = () => {
      void fm.editorOpen(filePath).then((res) => {
        if (res.error) {
          setStatusMsg(`reopen failed: ${res.error}`);
          return;
        }
        contentRef.current = res.content;
        mtimeRef.current = res.mtimeMs;
        baselineRef.current = res.content;
        setSeed(res.content); // remounts the editor with the on-disk bytes
        markDirty(false);
        setStatusMsg('reverted to disk');
        setTimeout(
          () => setStatusMsg((m) => (m === 'reverted to disk' ? null : m)),
          1500,
        );
      });
    };
    const onRevert = () => {
      if (!filePath) return;
      if (dirtyRef.current) {
        window.dispatchEvent(
          new CustomEvent('fm:confirm', {
            detail: {
              title: 'Revert to disk?',
              body: 'Discard unsaved changes and reload this file from disk.',
              confirmLabel: 'Revert',
              destructive: true,
              onConfirm: reread,
            },
          }),
        );
      } else {
        reread();
      }
    };
    const onClose = () => {
      const close = () => dispatch({ type: 'closeTab', index: tabIndex });
      if (dirtyRef.current) {
        window.dispatchEvent(
          new CustomEvent('fm:confirm', {
            detail: {
              title: 'Close without saving?',
              body: 'This file has unsaved changes that will be lost.',
              confirmLabel: 'Discard & close',
              cancelLabel: 'Keep editing',
              destructive: true,
              onConfirm: close,
            },
          }),
        );
      } else {
        close();
      }
    };
    window.addEventListener('fm:editor-save', onSave);
    window.addEventListener('fm:editor-revert', onRevert);
    window.addEventListener('fm:editor-close', onClose);
    return () => {
      window.removeEventListener('fm:editor-save', onSave);
      window.removeEventListener('fm:editor-revert', onRevert);
      window.removeEventListener('fm:editor-close', onClose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, filePath, tabIndex]);

  if (!tab) return null;

  const fileName = filePath ? basename(filePath) : '(unsaved)';
  const dirty = tab.dirty ?? false;

  return (
    <div className="edit-shell">
      <div className="edit-shell__header">
        <div className="edit-shell__title">
          {fileName}
          {dirty && <span className="edit-shell__dot" title="unsaved changes" />}
        </div>
        <div className="edit-shell__path" title={filePath}>{filePath}</div>
        <div className="edit-shell__actions">
          {statusMsg && <span className="edit-shell__status">{statusMsg}</span>}
          {!statusMsg && dirty && (
            <span className="edit-shell__status">{saving ? 'Saving…' : 'Editing…'}</span>
          )}
          <button
            type="button"
            className={`edit-shell__btn edit-shell__icon-btn${tab.chat ? ' edit-shell__icon-btn--on' : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent('fm:toggle-chat'))}
            title="Chat with this document (agent)"
            aria-label="Chat with this document"
          >
            💬
          </button>
          <button
            type="button"
            className="edit-shell__btn edit-shell__icon-btn"
            onClick={() => dispatch({ type: 'setMode', mode: 'command', buffer: '' })}
            title="All actions (:)"
            aria-label="All actions"
          >
            ☰
          </button>
          <button
            type="button"
            className="edit-shell__btn edit-shell__icon-btn edit-shell__close"
            onClick={() => {
              if (autosaveRef.current && dirtyRef.current) void doSave();
              dispatch({ type: 'closeTab', index: tabIndex });
            }}
            title="Close tab"
            aria-label="Close tab"
          >
            ×
          </button>
        </div>
      </div>
      <div className="edit-shell__body">
        {!loaded ? (
          <div className="edit-shell__loading">Loading…</div>
        ) : error ? (
          <div className="edit-shell__error">Couldn't open: {error}</div>
        ) : isMd ? (
          <MilkdownEditor
            initial={seed}
            onChange={onChange}
            filePath={filePath}
            autoFocus={isActive}
            registerFocus={(fn) => { editorFocusRef.current = fn; }}
          />
        ) : (
          <PlainEditor
            initial={seed}
            onChange={onChange}
            autoFocus={isActive}
            registerFocus={(fn) => { editorFocusRef.current = fn; }}
          />
        )}
      </div>
    </div>
  );
}

function PlainEditor({
  initial,
  onChange,
  autoFocus = true,
  registerFocus,
}: {
  initial: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
  registerFocus?: (fn: () => void) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    registerFocus?.(() => ref.current?.focus());
  }, [registerFocus]);
  // Uncontrolled so the browser keeps its native undo/redo stack
  // (a controlled `value` resets the stack on every keystroke). `key`
  // remounts with fresh contents only on a genuine reload, since the
  // parent changes `initial` only on file load — never on save.
  return (
    <textarea
      key={initial}
      ref={ref}
      autoFocus={autoFocus}
      className="edit-shell__textarea"
      defaultValue={initial}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// Caret offset per file, kept across editor unmounts so switching tabs
// away and back lands you where you left off instead of at end-of-doc.
const caretByPath = new Map<string, number>();

function MilkdownEditor({
  initial,
  onChange,
  filePath,
  autoFocus = true,
  registerFocus,
}: {
  initial: string;
  onChange: (next: string) => void;
  filePath: string;
  autoFocus?: boolean;
  registerFocus?: (fn: () => void) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  // Avoid stale-closure: onChange may change between renders, but
  // Crepe's listener is attached once.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Keep a live handle to the prose view so the unmount cleanup can
  // snapshot the caret before tear-down.
  const viewRef = useRef<EditorView | null>(null);
  // When Crepe can't render a file (e.g. a malformed GFM table produces an
  // "Invalid array passed to renderSpec" crash deep in ProseMirror), the
  // WYSIWYG editor mounts but paints nothing — a silent blank. We detect
  // that and fall back to the plain-text editor so the content is never
  // lost behind an empty pane. Note: the crash is async (inside ProseMirror's
  // view update), so a React error boundary wouldn't catch it — we catch
  // create() rejections and also probe the rendered DOM after mount.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    setFailed(false);
    let crepe: Crepe;
    try {
      crepe = new Crepe({
        root: hostRef.current,
        defaultValue: initial,
        features: {
          // The Latex feature scans prose for `$` and treats stray Unicode
          // (ordinary en-dashes "–") as math input, flooding the console
          // with "LaTeX-incompatible input" warnings and adding render
          // surface that can crash. This is a note editor, not a math doc.
          [Crepe.Feature.Latex]: false,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: {
            text: 'Note title here',
            mode: 'block',
          },
        },
      });
    } catch {
      setFailed(true);
      return;
    }
    crepeRef.current = crepe;
    let disposed = false;
    void crepe.create().then(() => {
      if (disposed) return;
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
      });
      // Render sanity check: if we seeded non-empty markdown but the editor
      // painted nothing, Crepe crashed mid-render. Drop to the plain editor.
      const probeRender = () => {
        if (disposed) return;
        if (!initial.trim()) return;
        const pm = hostRef.current?.querySelector('.ProseMirror');
        const rendered = (pm?.textContent ?? '').trim().length > 0;
        if (!rendered) setFailed(true);
      };
      const focusEditor = () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            viewRef.current = view;
            // Restore the saved caret for this file if we've seen it
            // before. Fresh opens (e.g. `:note`) fall back to end-of-doc
            // so the first keystroke extends the seeded `# `.
            const end = view.state.doc.content.size;
            const saved = filePath ? caretByPath.get(filePath) : undefined;
            const pos = saved != null ? Math.min(saved, end) : end;
            const sel = TextSelection.create(view.state.doc, pos);
            view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
            view.focus();
          });
        } catch { /* ignore — editor may have torn down */ }
      };
      // Expose focus so EditShell can re-focus this editor when its tab is
      // re-activated (the editor stays mounted, so this is the only hook).
      registerFocus?.(focusEditor);
      // Auto-focus only the active editor on create — a backgrounded edit
      // tab that mounted for persistence must not steal the keyboard.
      // Two ticks: first for React commit, second for the chip overlay
      // (which closes after dispatching openEditTab) to release focus.
      if (autoFocus) {
        setTimeout(focusEditor, 0);
        setTimeout(focusEditor, 50);
      }
      // Probe after the view has had a chance to render (ProseMirror renders
      // synchronously, but give the double-focus pass room first).
      setTimeout(probeRender, 60);
    }).catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
      // Snapshot the caret so a remount (tab-switch back) restores it.
      try {
        const view = viewRef.current;
        if (view && filePath) {
          caretByPath.set(filePath, view.state.selection.from);
        }
      } catch { /* noop */ }
      viewRef.current = null;
      try {
        crepe.destroy();
      } catch {
        /* noop */
      }
      crepeRef.current = null;
    };
    // We deliberately mount Crepe once per initial value. If the file is
    // reloaded with different bytes (rare), the parent passes a new
    // `initial` and we remount — simpler than setMarkdown gymnastics.
  }, [initial]);

  // Crepe couldn't render this file — show the raw markdown in the plain
  // editor so it's editable rather than a silent blank. `key` ties the
  // textarea to the file so switching files re-seeds it.
  if (failed) {
    return (
      <PlainEditor
        key={`fallback:${filePath}`}
        initial={initial}
        onChange={onChange}
        autoFocus={autoFocus}
        registerFocus={registerFocus}
      />
    );
  }

  return <div ref={hostRef} className="edit-shell__milkdown" />;
}
