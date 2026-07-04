// The in-app browser tab. A thin wrapper over the shared BrowserSurface (the ONE
// embedded-browser surface, also used by the operator session) in tab mode.
// reapBrowserViews is re-exported so App can keep releasing closed tabs' views.
import { useStore } from '../store';
import { BrowserSurface, reapBrowserViews } from './BrowserSurface';

export { reapBrowserViews };

export function BrowserPane({ tabId, url }: { tabId: string; url: string }) {
  const { state, dispatch } = useStore();
  return (
    <BrowserSurface
      tabId={tabId}
      url={url}
      // task-7eb4b6cdae0f — thread the page title into THIS tab so the tab-bar
      // labels it with the page rather than a generic "Browser". Blank titles
      // (about:blank) fall back to the generic label in Tabbar. Only write when
      // it actually changed, keyed by tab id (the index can shift as tabs move).
      onTitle={(title) => {
        const index = state.tabs.findIndex((t) => t.id === tabId);
        if (index < 0) return;
        if (state.tabs[index].browserTitle === title) return;
        dispatch({ type: 'updateTab', index, patch: { browserTitle: title } });
      }}
    />
  );
}
