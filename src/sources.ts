// Renderer hook for the multi-source registry (breezed plan P4).
// Mirrors the useTasks pattern: pull once, re-pull on the
// 'sources:changed' broadcast (connect/disconnect/connecting).

import { useEffect, useState } from 'react';
import { fm } from './bridge';

export type SourceInfo = {
  id: string;
  kind: 'local' | 'remote';
  status: 'connected' | 'connecting';
};

export function useSources(): SourceInfo[] {
  const [sources, setSources] = useState<SourceInfo[]>([
    { id: 'local', kind: 'local', status: 'connected' },
  ]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await fm.sourcesList();
        if (!cancelled) setSources(s);
      } catch {
        /* keep last known */
      }
    };
    load();
    const unsub = fm.onSourcesChanged(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return sources;
}
