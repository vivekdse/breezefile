// Ambient declaration for vite-electron-options.mjs, so vite.config.ts
// (checked under tsconfig.node.json, which has no allowJs) can import it
// without TS7016. Mirrors vite-plugin-electron/simple's own option shapes
// (ElectronSimpleOptions['main' | 'preload']) rather than duplicating them,
// so this stays in sync with whatever that library's .d.mts declares.
import type { ElectronOptions, RolldownOrRollupOptions } from 'vite-plugin-electron';

export declare const mainOptions: ElectronOptions;
export declare const preloadOptions: Omit<ElectronOptions, 'entry'> & {
  input: RolldownOrRollupOptions['input'];
};
