// Telling the owner something that happened in Civilization mode (an agent's
// ask, D630; a health warning, agents.md D731): a toast while the page has
// focus, else a system notification, as `jhin.notifications` allows.
import type { PluginContext } from "@jhin/sdk";
import type { Toasts } from "@jhin/ui";
import type { ReactNode } from "react";

/** What `jhin.notifications` says about telling the user things (its own section). */
const NOTIFICATIONS_SECTION = "jhin.notifications";

export interface OwnerNews {
  readonly title: string;
  readonly body: string;
  /** Replaces an earlier system notification with the same tag. */
  readonly tag: string;
  readonly icon: ReactNode;
  readonly type?: "warning" | "error";
  /** The toast's button and what a click on either opens. */
  readonly actionLabel: string;
  readonly open: () => void;
}

/** Tells the owner `news`: a toast with focus (unless `inApp` is off), else a system notification. */
export function tellOwner(
  config: PluginContext["config"],
  toasts: Toasts | undefined,
  news: OwnerNews,
): void {
  let settings: { mode?: string; inApp?: boolean } = {};
  try {
    settings = config.get<{ mode?: string; inApp?: boolean }>(NOTIFICATIONS_SECTION);
  } catch {
    // No `jhin.notifications`: its defaults.
  }
  if (document.visibilityState === "visible" && document.hasFocus()) {
    if (settings.inApp === false) return;
    toasts?.show({
      type: news.type ?? "warning",
      title: news.title,
      description: news.body,
      data: { hideCopyButton: true, leadingIcon: news.icon },
      action: { label: news.actionLabel, onClick: news.open },
    });
    return;
  }
  if (
    (settings.mode === "notifications" || settings.mode === "notifications-and-sound") &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    const notification = new Notification(news.title, { body: news.body, tag: news.tag });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      news.open();
    });
  }
}
