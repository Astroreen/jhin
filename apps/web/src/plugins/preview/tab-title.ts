// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: the `preview` case of
// `surfaceTitle` in apps/web/src/components/RightPanelTabs.tsx.
import type { PreviewTab } from "@jhin/preview-api";

/** T3's tab title: the page's title, else its host, else "Browser". */
export function tabTitle(tab: PreviewTab | undefined): string {
  const status = tab?.navStatus;
  if (status === undefined || status.state === "idle") return "Browser";
  if (status.title.trim() !== "") return status.title;
  try {
    return new URL(status.url).host || "Browser";
  } catch {
    return "Browser";
  }
}

/** The resource of T3's new tab surface, `browser:new` (t3-parity.md D1424). */
export const NEW_TAB = "new";
