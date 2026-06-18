// SPIKE (spike/playwright-cdp): the dedicated agent-chat overlay.
//
// Rendered (instead of the full App) in the small always-on-top overlay window
// the playwright flow opens — see electron/browser/overlay.ts and main.tsx.
// Shows ONLY the agent's terminal for `ptyId`, mirroring its stream, plus a
// header that flags when Claude is WAITING on the user (term:fg 'waiting').
import { useEffect, useState } from 'react';
import { Terminal } from './Terminal';
import { fm } from '../bridge';
import './AgentOverlay.css';

export function AgentOverlay({ ptyId }: { ptyId: number }) {
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    // Mirror this pty's term:* stream into this window.
    fm.termMirror(ptyId);
    const off = fm.onTermFg((id, _busy, _comm, state) => {
      if (id === ptyId) setWaiting(state === 'waiting');
    });
    return () => {
      off();
      fm.termUnmirror(ptyId);
    };
  }, [ptyId]);

  return (
    <div className={`agent-overlay${waiting ? ' agent-overlay--waiting' : ''}`}>
      <div className="agent-overlay__bar">
        <span className="agent-overlay__title">Claude</span>
        {waiting && <span className="agent-overlay__badge">needs you</span>}
      </div>
      <div className="agent-overlay__term">
        <Terminal ptyId={ptyId} cwd="" isActive />
      </div>
    </div>
  );
}
