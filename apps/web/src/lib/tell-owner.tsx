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

/**
 * Tells the owner `news`: with focus, a toast (and nothing at all when
 * `inApp` is off: no system notification is tried); without focus, a system
 * notification when `jhin.notifications.mode` allows it, else a toast left
 * on the page (D630), which the owner may not see until they return. Returns whether anything was shown: with no
 * toasts in the client and no system notification, nothing was (the caller
 * logs it).
 */
export function tellOwner(
  config: PluginContext["config"],
  toasts: Toasts | undefined,
  news: OwnerNews,
): boolean {
  let settings: { mode?: string; inApp?: boolean } = {};
  try {
    settings = config.get<{ mode?: string; inApp?: boolean }>(NOTIFICATIONS_SECTION);
  } catch {
    // No `jhin.notifications`: its defaults.
  }
  const toast = () => {
    if (settings.inApp === false || toasts === undefined) return false;
    toasts.show({
      type: news.type ?? "warning",
      title: news.title,
      description: news.body,
      data: { hideCopyButton: true, leadingIcon: news.icon },
      action: { label: news.actionLabel, onClick: news.open },
    });
    return true;
  };
  if (document.visibilityState === "visible" && document.hasFocus()) return toast();
  if (
    (settings.mode === "notifications" || settings.mode === "notifications-and-sound") &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      const notification = new Notification(news.title, { body: news.body, tag: news.tag });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        news.open();
      });
      return true;
    } catch {
      // Some browsers refuse it (mobile, an insecure context): the page tells it instead.
    }
  }
  // No system notification: the toast waits on the page for the owner's return.
  return toast();
}
