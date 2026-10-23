// The thread details panel (D802): its command, keybinding and contributions. The
// toggle and panel are thread-details-panel.tsx and the Lineage section lineage.tsx,
// each a chunk of its own (D440). docs/plans/t3-parity.md, D802.
import type {
  ChatHeaderActionProps,
  ChatThreadDetailsProps,
  Keybindings,
  Navigation,
  NodeTarget,
  ThreadsCatalog,
} from "@jhin/client-api";
import { targetKey } from "@jhin/client-api";
import { z, type PluginContext } from "@jhin/sdk";
import type { SlotRegistry } from "@jhin/ui";

import { lazyChunk } from "../../lib/lazy-chunk.tsx";

/** The thread's key in the visibility store: its node and id. */
export const detailsKey = (target: NodeTarget, threadId: string) =>
  `${targetKey(target)}|${threadId}`;

/** Where a thread's details show (D1350): beside a wide chat, or in the header's popover. */
export type DetailsPresentation = "inline" | "popover";

/** T3's THREAD_DETAILS_CARD_GAP, its card's width and the clearance it keeps from the chat. */
const CARD_GAP = 12;
const CARD_WIDTH = 280;
const CARD_CLEARANCE = 32;
/** The chat lane T3 keeps beside the card: 40rem, and its padding (`ps-3 sm:ps-12`). */
const MIN_CHAT_WIDTH = 640;
const LANE_PADDING = { narrow: 12, wide: 48 };

/** The lane's padding on this screen: Tailwind's `sm` is the viewport's 40rem. */
export const lanePadding = () =>
  typeof window !== "undefined" && window.matchMedia("(min-width: 40rem)").matches
    ? LANE_PADDING.wide
    : LANE_PADDING.narrow;

/**
 * Where the card goes beside a chat of `width` × `height` (T3's
 * `resolveThreadDetailsCardLayout`): `null` when the chat would get narrower than its lane or
 * the card shorter than 160px, and it is the popover's instead.
 */
export function inlineDetailsPlacement(
  width: number,
  height: number,
  topInset = 0,
  padding = lanePadding(),
) {
  const x = width - CARD_WIDTH - CARD_GAP;
  if (x - CARD_CLEARANCE - padding < MIN_CHAT_WIDTH) return null;
  const y = CARD_GAP + topInset;
  const cardHeight = height - y - CARD_GAP;
  if (cardHeight < 160) return null;
  return { right: CARD_GAP, top: y, width: CARD_WIDTH, height: cardHeight };
}

/**
 * How far the chat's lane moves left of centre to keep clear of the inline card (T3's
 * `resolveChatCanvasLayout` with its `detailsCard`): the padding to add at the lane's end, 0
 * when the centred lane already ends 32px before the card.
 */
export function laneInsetBesideCard(
  width: number,
  maxChatWidth: number,
  padding = lanePadding(),
): number {
  const laneRight = width - CARD_GAP - CARD_WIDTH - CARD_CLEARANCE;
  const centered = Math.max(0, Math.min(maxChatWidth, width - padding * 2));
  const laneWidth = Math.max(0, Math.min(centered, laneRight - padding));
  const left = Math.max(padding, Math.min((width - laneWidth) / 2, laneRight - laneWidth));
  return Math.max(0, width - left * 2 - laneWidth);
}

/**
 * Whether each thread's details show, per presentation, as T3's
 * `threadPanelVisibilityByThreadKey`: the inline card is open until it is closed, the
 * popover closed until it is opened. Kept for the page's life, by thread.
 */
export function createDetailsVisibility() {
  const visibility = new Map<string, { inline: boolean; popover: boolean }>();
  /** The presentation the thread's view has room for, as it last measured it. */
  const presentations = new Map<string, DetailsPresentation>();
  /** The threads whose inline card has a section to show, as their view reports. */
  const filled = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const of = (key: string) => visibility.get(key) ?? { inline: true, popover: false };
  /**
   * Where the toggle works: the card beside the chat when there is room for it and it has
   * something to show; else the popover, which says "No details for this thread".
   */
  const effective = (key: string): DetailsPresentation =>
    presentations.get(key) === "inline" && filled.has(key) ? "inline" : "popover";
  return {
    /** `undefined` until the thread's view has measured its room. */
    presentation: (key: string): DetailsPresentation | undefined => presentations.get(key),
    effective,
    open: (key: string, presentation: DetailsPresentation) => of(key)[presentation],
    set(key: string, presentation: DetailsPresentation, open: boolean) {
      if (of(key)[presentation] === open) return;
      visibility.set(key, { ...of(key), [presentation]: open });
      changed();
    },
    /** The view reports its room; the popover closes once the card fits beside the chat. */
    setPresentation(key: string, presentation: DetailsPresentation | undefined) {
      if (presentations.get(key) === presentation) return;
      if (presentation === undefined) presentations.delete(key);
      else presentations.set(key, presentation);
      if (effective(key) === "inline") visibility.set(key, { ...of(key), popover: false });
      changed();
    },
    /** Whether the inline card has a section to show; it is mounted, open or not. */
    setFilled(key: string, on: boolean) {
      if (filled.has(key) === on) return;
      if (on) filled.add(key);
      else filled.delete(key);
      if (effective(key) === "inline") visibility.set(key, { ...of(key), popover: false });
      changed();
    },
    /** Whether the inline card is on screen: the chat's lane keeps clear of it. */
    shown: (key: string) => effective(key) === "inline" && of(key).inline,
    /** Toggles the presentation the thread shows now (T3's `toggleThreadPanel`). */
    toggle(key: string) {
      const presentation = effective(key);
      visibility.set(key, { ...of(key), [presentation]: !of(key)[presentation] });
      changed();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type DetailsVisibility = ReturnType<typeof createDetailsVisibility>;

/**
 * The header's toggle, the panel it opens, `chat.thread-details.toggle` and
 * the Lineage section (D802).
 */
export function registerThreadDetails(
  context: PluginContext,
  services: {
    readonly threads: ThreadsCatalog;
    readonly navigation: Navigation;
    readonly slots: SlotRegistry;
    readonly keybindings: Keybindings | undefined;
    readonly visibility: DetailsVisibility;
  },
) {
  const { threads, navigation, slots, keybindings, visibility } = services;
  /** The toggles on screen, newest last: the command works the newest (one, in Jhin's one thread view). */
  const toggles: (() => void)[] = [];

  context.commands.register({
    name: "chat.thread-details.toggle",
    title: "Toggle thread details",
    description:
      "Opens or closes the open thread's details panel (its lineage and what plugins add)",
    input: z.object({}),
    /** `toggled`: false when no thread is open, so there was no panel to toggle. */
    output: z.object({ toggled: z.boolean() }),
    handler: () => {
      const toggle = toggles.at(-1);
      toggle?.();
      return { toggled: toggle !== undefined };
    },
  });
  if (keybindings !== undefined) {
    context.subscriptions.add(
      keybindings.addDefaults([
        { key: "mod+shift+b", command: "chat.thread-details.toggle", when: "!terminalFocus" },
      ]),
    );
  }

  // The toggle and its panel are a chunk of their own (D440), loaded with the header.
  const ThreadDetailsToggle = lazyChunk(
    () =>
      import("./thread-details-panel.tsx").then((module) =>
        module.createThreadDetailsToggle({ keybindings, toggles, visibility }),
      ),
    { loading: () => null, failed: () => null },
  );
  context.subscriptions.add(
    slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
      id: "jhin.chat.thread-details",
      order: -20,
      component: ThreadDetailsToggle,
    }),
  );

  // Its rows load with the panel, a chunk of their own (D440).
  const Lineage = lazyChunk(
    () =>
      import("./lineage.tsx").then((module) =>
        module.createLineage({ threads, navigation, commands: context.commands }),
      ),
    {
      // Loaded ahead, once the header's toggle shows (below): opening the panel
      // rarely waits for it.
      loading: () => null,
      // Shows nothing, as a thread without lineage does; the panel opened again loads it again.
      failed: () => null,
    },
  );
  context.subscriptions.add(
    slots.contribute<ChatThreadDetailsProps>("chat.thread.details", {
      id: "jhin.chat.lineage",
      order: 100,
      component: Lineage,
    }),
  );
}
