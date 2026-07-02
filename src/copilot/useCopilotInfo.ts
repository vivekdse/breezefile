import { useEffect, useState } from 'react';
import { fm } from '../bridge';

export type CopilotInfo = { enabled: boolean; port?: number; endpoint?: string };

/**
 * Fetches the main-process CopilotKit runtime status once on mount.
 * `enabled` is false whenever no Anthropic key is configured — the caller
 * should degrade to a setup hint rather than mounting the CopilotKit provider.
 */
export function useCopilotInfo(): CopilotInfo | null {
  const [info, setInfo] = useState<CopilotInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    fm.copilot
      .info()
      .then((res) => {
        if (!cancelled) setInfo(res);
      })
      .catch(() => {
        if (!cancelled) setInfo({ enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
