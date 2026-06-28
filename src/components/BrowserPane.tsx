// The in-app browser tab. A thin wrapper over the shared BrowserSurface (the ONE
// embedded-browser surface, also used by the operator session) in tab mode.
// reapBrowserViews is re-exported so App can keep releasing closed tabs' views.
import { BrowserSurface, reapBrowserViews } from './BrowserSurface';

export { reapBrowserViews };

export function BrowserPane({ tabId, url }: { tabId: string; url: string }) {
  return <BrowserSurface tabId={tabId} url={url} />;
}
