import { createContext, useContext } from 'react';
import type { Entry } from './types';

export type RenameMode = 'full' | 'beforeExt' | 'append' | 'prepend';

export type OverlayApi = {
  requestRename: (entry: Entry, mode?: RenameMode) => void;
  requestMkdir: () => void;
};

export const OverlayCtx = createContext<OverlayApi | null>(null);

export function useOverlays(): OverlayApi {
  const ctx = useContext(OverlayCtx);
  if (!ctx) throw new Error('useOverlays outside provider');
  return ctx;
}
