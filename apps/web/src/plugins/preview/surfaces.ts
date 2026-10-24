// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: the browser's part of
// apps/web/src/rightPanelStore.ts (reconcileBrowserSurfaces and its hidden tabs, as ChatView.tsx
// computes them) and apps/web/src/hooks/useRightPanelSurfaceClose.ts with
// agentControlledBrowserCloseConfirmation of components/ChatView.logic.ts.
//
// A thread's browser tabs as surfaces of the right panel (t3-parity.md D1424).
import type { RightPanelSurface } from "@jhin/client-api";
import type { PreviewTab } from "@jhin/preview-api";

import { NEW_TAB } from "./tab-title.ts";

/**
 * The browser surfaces a thread has, as T3 reconciles them: its tabs, but not one its agent keeps
 * hidden (`reveal` false) unless it already shows, and the new tab's start while it is there.
 */
export function browserSurfaceResources(
  tabs: readonly PreviewTab[],
  present: ReadonlySet<string | undefined>,
): string[] {
  const resources = tabs
    // T3 hides a server tab the agent did not reveal; the app's own tabs always show.
    .filter((tab) => tab.reveal || tab.desktop === true || present.has(tab.tabId))
    .map((tab) => tab.tabId);
  if (present.has(NEW_TAB)) resources.push(NEW_TAB);
  return resources;
}

/** T3's agentControlledBrowserCloseConfirmation: what to ask before closing tabs an agent drives. */
export function agentBrowserCloseQuestion(
  count: number,
): { title: string; description: string } | undefined {
  if (count === 0) return undefined;
  return count === 1
    ? {
        title: "Close browser while the agent is using it?",
        description:
          "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
      }
    : {
        title: `Close ${count} browsers while the agent is using them?`,
        description:
          "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.",
      };
}

/**
 * Closes the tabs of browser surfaces the user closes (T3's useRightPanelSurfaceClose): after
 * asking while an agent drives one, and only when every close went through, so a tab that stays
 * open on the node keeps its surface.
 */
export async function releaseBrowserTabs(input: {
  readonly tabs: readonly PreviewTab[];
  readonly closing: readonly RightPanelSurface[];
  confirm(question: { title: string; description: string }): Promise<boolean>;
  close(tabId: string): Promise<unknown>;
}): Promise<boolean> {
  const closed = input.closing
    .map((surface) => input.tabs.find((tab) => tab.tabId === surface.resource))
    .filter((tab) => tab !== undefined);
  const question = agentBrowserCloseQuestion(
    closed.filter((tab) => tab.owner === "agent" && tab.controller === null).length,
  );
  if (question !== undefined && !(await input.confirm(question))) return false;
  const results = await Promise.allSettled(closed.map((tab) => input.close(tab.tabId)));
  return results.every((result) => result.status === "fulfilled");
}
