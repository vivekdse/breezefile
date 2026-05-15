import { useEffect, useRef, useState } from 'react';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { useStore } from '../store';
import { fm } from '../bridge';
import { basename } from '../actions';
import { humanizeError } from '../errorMessages';
import './EditShell.css';

/**
 * fm-vu55 — editor shell for an `edit`-kind tab. Routes by extension:
 * `.md` / `.mdx` get Milkdown (WYSIWYM with HTML elements styled by the
 * app theme), everything else gets a monospaced plain-text editor.
 *
 * Dirty tracking lives on the tab (state.tabs[i].dirty). ⌘S / Ctrl+S
 * saves atomically through `fm.editorSave`, which writes via tmp-file
 * + rename and refuses to clobber a file modified on disk since open.
 */
export function EditShell({ tabIndex }: { tabIndex: number }) {
  const { state, dispatch } = useStore();
  const tab = state.tabs[tabIndex];
  const filePath = tab?.editPath ?? '';
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const isMd = ext === 'md' || ext === 'mdx';

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialContent, setInitialContent] = useState('');
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

  // Load file contents on mount / when path changes.
  useEffect(() => {
    if (!filePath) return;
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
      setInitialContent(res.content);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const markDirty = (dirty: boolean) => {
    if (dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    dispatch({ type: 'setTabDirty', index: tabIndex, dirty });
  };

  const onChange = (next: string) => {
    contentRef.current = next;
    const dirty = next !== initialContent;
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
      setInitialContent(contentRef.current);
      markDirty(false);
      setStatusMsg('saved');
      // Clear the "saved" toast after a beat so it doesn't linger.
      setTimeout(() => setStatusMsg((m) => (m === 'saved' ? null : m)), 1500);
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

  // ⌘S / Ctrl+S to save, scoped to this tab being active.
  useEffect(() => {
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
  }, [filePath, saving]);

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
          <MilkdownEditor initial={initialContent} onChange={onChange} />
        ) : (
          <PlainEditor initial={initialContent} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function PlainEditor({
  initial,
  onChange,
}: {
  initial: string;
  onChange: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  // Re-seed when the file is reloaded (different initial).
  useEffect(() => setValue(initial), [initial]);
  return (
    <textarea
      className="edit-shell__textarea"
      value={value}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

function MilkdownEditor({
  initial,
  onChange,
}: {
  initial: string;
  onChange: (next: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  // Avoid stale-closure: onChange may change between renders, but
  // Crepe's listener is attached once.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const crepe = new Crepe({ root: hostRef.current, defaultValue: initial });
    crepeRef.current = crepe;
    let disposed = false;
    void crepe.create().then(() => {
      if (disposed) return;
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
      });
    });
    return () => {
      disposed = true;
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

  return <div ref={hostRef} className="edit-shell__milkdown" />;
}
