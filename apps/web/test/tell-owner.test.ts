import type { PluginContext } from "@jhin/sdk";
import type { Toasts } from "@jhin/ui";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { tellOwner, type OwnerNews } from "../src/lib/tell-owner.tsx";

const globals = globalThis as Record<string, unknown>;
const saved = { document: globals["document"], Notification: globals["Notification"] };
afterEach(() => {
  globals["document"] = saved.document;
  globals["Notification"] = saved.Notification;
});

/** The page's focus, and the system notifications it shows. */
function page(focused: boolean) {
  globals["document"] = { visibilityState: "visible", hasFocus: () => focused };
  const shown: { title: string; body: string; click: () => void }[] = [];
  globals["Notification"] = class {
    static permission = "granted";
    constructor(title: string, options: { body: string }) {
      shown.push({ title, body: options.body, click: () => this.listener?.() });
    }
    listener: (() => void) | undefined;
    addEventListener(_type: string, listener: () => void) {
      this.listener = listener;
    }
    close() {}
  };
  globals["window"] ??= { focus() {} };
  return shown;
}

const config = (values: Record<string, unknown>) =>
  ({ get: () => values }) as unknown as PluginContext["config"];

function toasts() {
  const shown: { title: string; action: { label: string; onClick: () => void } }[] = [];
  return { shown, toasts: { show: (toast: never) => shown.push(toast) } as unknown as Toasts };
}

describe("telling the owner (D630, D731)", () => {
  const opened: string[] = [];
  const news: OwnerNews = {
    title: "Ceremony outgrows progress: Mission Doghouse",
    body: "3 ceremony against 0 progress",
    tag: "w1",
    icon: null,
    actionLabel: "Open health",
    open: () => opened.push("w1"),
  };

  it("shows a toast with focus, whose action opens the news", () => {
    page(true);
    const { shown, toasts: sink } = toasts();
    tellOwner(config({}), sink, news);
    expect(shown.map((toast) => toast.title)).toEqual([news.title]);
    shown[0]!.action.onClick();
    expect(opened).toEqual(["w1"]);
  });

  it("shows nothing in the app when in-app notifications are off", () => {
    page(true);
    const { shown, toasts: sink } = toasts();
    tellOwner(config({ inApp: false }), sink, news);
    expect(shown).toEqual([]);
  });

  it("sends a system notification without focus when the settings allow it, else leaves a toast", () => {
    const notifications = page(false);
    const { shown, toasts: sink } = toasts();
    tellOwner(config({ mode: "off" }), sink, news);
    expect(notifications).toEqual([]);
    // No system notification: the toast waits on the page instead of nothing.
    expect(shown.map((toast) => toast.title)).toEqual([news.title]);
    shown.length = 0;
    tellOwner(config({ mode: "notifications" }), sink, news);
    expect(notifications.map((item) => item.body)).toEqual([news.body]);
    expect(shown).toEqual([]);
  });

  it("falls back to a toast when the browser refuses a system notification", () => {
    page(false);
    globals["Notification"] = class {
      static permission = "granted";
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    };
    const { shown, toasts: sink } = toasts();
    tellOwner(config({ mode: "notifications" }), sink, news);
    expect(shown.map((toast) => toast.title)).toEqual([news.title]);
  });

  it("says when it told nobody: no toasts in the client and no system notification", () => {
    page(true);
    expect(tellOwner(config({}), undefined, news)).toBe(false);
    page(false);
    expect(tellOwner(config({ mode: "off" }), undefined, news)).toBe(false);
    expect(tellOwner(config({ mode: "notifications" }), undefined, news)).toBe(true);
    const { toasts: sink } = toasts();
    page(true);
    expect(tellOwner(config({}), sink, news)).toBe(true);
    expect(tellOwner(config({ inApp: false }), sink, news)).toBe(false);
  });
});
