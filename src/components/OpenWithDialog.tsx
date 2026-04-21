import { useState } from 'react';
import { fm } from '../bridge';
import './OpenWithDialog.css';

export interface OpenWithDialogProps {
  filePath: string;
  ext?: string;
  appPath: string;
  onClose: () => void;
}

/**
 * Confirmation modal shown after the user picks an app via the native
 * file dialog. Lets them (a) launch with that app once, or (b) bind the
 * app as the default for this extension so future "Open" calls route
 * there automatically.
 *
 * Styled with editorial tokens (--panel / --panel-2 / --ink / --accent
 * / --rule) to match the rest of the chrome.
 */
export function OpenWithDialog({ filePath, ext, appPath, onClose }: OpenWithDialogProps) {
  const [remember, setRemember] = useState(false);
  const appName = appPath.split('/').pop()?.replace(/\.app$/, '') || appPath;
  const extLabel = ext ? `.${ext}` : '';

  async function handleConfirm() {
    try {
      if (remember && ext) {
        await fm.setBinding(ext, appPath);
      }
      await fm.open(filePath, appPath);
    } finally {
      onClose();
    }
  }

  return (
    <div className="openwith-backdrop" onClick={onClose} role="presentation">
      <div
        className="openwith-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openwith-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="openwith-eyebrow">Open With</div>
        <h2 id="openwith-title" className="openwith-title">
          Open with {appName}?
        </h2>
        <div className="openwith-path" title={filePath}>
          {filePath}
        </div>

        {ext && (
          <label className="openwith-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>
              Always open <code>{extLabel}</code> files with {appName}
            </span>
          </label>
        )}

        <div className="openwith-actions">
          <button
            type="button"
            className="openwith-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="openwith-btn openwith-btn--primary"
            onClick={handleConfirm}
            autoFocus
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
