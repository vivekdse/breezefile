// task-570f3471b28e / task-ee50c5c1be17 — type surface for the pure
// tabOrder.mjs helpers: the single source of truth for the VISIBLE tab order
// shared by the Tabbar render and the ⌘/Ctrl+<n> tab-switch shortcut. Pure: no
// fs / IPC / React.

/** A minimal view of a tab — only its kind drives zone placement. */
export interface TabLike {
  kind?: string;
}

/** True if the tab renders in the right-hand "task" zone of the Tabbar. */
export declare function isTaskZone(tab: TabLike): boolean;

/**
 * Absolute `state.tabs` indices in the order the Tabbar renders them
 * (folder zone first, then task zone). Position + 1 is the tab's shown number.
 */
export declare function visibleTabOrder(tabs: TabLike[]): number[];

/**
 * Map a 1-based visible position (the number on the tab) to the absolute
 * `state.tabs` index it focuses, or undefined if out of range.
 */
export declare function tabIndexForPosition(
  tabs: TabLike[],
  pos: number,
): number | undefined;
