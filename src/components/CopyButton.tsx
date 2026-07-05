// task-f523fcb5b474 — shared copy-to-clipboard affordance. A small icon/text
// button that writes `text` via navigator.clipboard.writeText and shows a
// transient "Copied" state, mirroring ModeLine's existing Copy/Copied pattern
// (src/components/ModeLine.tsx) so this doesn't invent a second convention.
//
// PHI: `text` may be task title/body/output content. It is handed to the
// clipboard on explicit user click only — never logged, printed, or persisted
// by this component.
import { useEffect, useRef, useState } from 'react';
import './CopyButton.css';

export function CopyButton({
  getText,
  label = 'Copy',
  title = 'Copy to clipboard',
  className = '',
}: {
  /** Lazily resolves the value to copy — avoids holding PHI in a closure prop
   *  any longer than the click that needs it. */
  getText: () => string | null | undefined;
  label?: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = getText();
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' copy-btn--copied' : ''} ${className}`.trim()}
      title={copied ? 'Copied' : title}
      aria-label={copied ? 'Copied' : title}
      onClick={onClick}
    >
      {copied ? '✓ Copied' : `⧉ ${label}`}
    </button>
  );
}
