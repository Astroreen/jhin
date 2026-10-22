// The layout follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/AppSidebarLayout.tsx.
import {
  MODES_CAPABILITY,
  SETTINGS_CAPABILITY,
  UI_CONFIG_SECTION,
  UiConfig,
  type DeviceSettings,
  type Modes,
} from "@jhin/client-api";
import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import {
  DialogHost,
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  Slot,
  SlotsProvider,
  ToastProvider,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  cn,
  createDialogs,
  createSlotRegistry,
  createToasts,
  useSidebar,
} from "@jhin/ui";
import { useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import { builtin } from "../lib/builtin.ts";
import { useConfig, useShortcutLabels } from "../lib/hooks.ts";
import { useModes } from "../lib/use-modes.ts";
import { APPEARANCE_SECTION, Appearance } from "../lib/settings.ts";
import { KEYBINDINGS_CAPABILITY, type Keybindings } from "./keybindings.ts";

const SIDEBAR_WIDTH_STORAGE_KEY = "jhin.sidebar.width";
const SIDEBAR_DEFAULT_WIDTH = 16 * 16;
const SIDEBAR_MIN_WIDTH = 13 * 16;
const MAIN_CONTENT_MIN_WIDTH = 40 * 16;

const maximumSidebarWidth = (viewport: number) =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewport) - MAIN_CONTENT_MIN_WIDTH);

function initialSidebarWidth(): number {
  let stored: number | null = null;
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof value === "number" && Number.isFinite(value)) stored = value;
  } catch {
    // An unreadable value is the default.
  }
  const preferred = stored === null ? SIDEBAR_DEFAULT_WIDTH : Math.max(SIDEBAR_MIN_WIDTH, stored);
  return Math.min(preferred, maximumSidebarWidth(window.innerWidth));
}

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Puts the appearance on the document: the `dark` class and the chat width. */
function applyAppearance(appearance: Appearance, animate: boolean) {
  const root = document.documentElement;
  const dark = appearance.mode === "dark" || (appearance.mode === "system" && prefersDark());
  if (root.classList.contains("dark") !== dark) {
    // No transitions while the palette flips (T3 Code does the same).
    if (!animate) root.classList.add("no-transitions");
    root.classList.toggle("dark", dark);
    if (!animate) {
      void root.offsetHeight;
      requestAnimationFrame(() => root.classList.remove("no-transitions"));
    }
  }
  if (appearance.chatWidth === "comfortable") delete root.dataset["chatWidth"];
  else root.dataset["chatWidth"] = appearance.chatWidth;
}

/** Lets commands reach the sidebar state that lives in React context. */
const sidebarHandle: { toggle?: () => void } = {};

function SidebarHandle() {
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    sidebarHandle.toggle = toggleSidebar;
    return () => {
      if (sidebarHandle.toggle === toggleSidebar) delete sidebarHandle.toggle;
    };
  }, [toggleSidebar]);
  return null;
}

function SidebarControl({ keybindings }: { keybindings: Keybindings | undefined }) {
  const { isMobile, mobileSheetMounted } = useSidebar();
  const label = useShortcutLabels(keybindings)("ui.sidebar.toggle");
  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              aria-label="Toggle main sidebar"
              className="pointer-events-auto"
              variant="ghost"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{label === undefined ? "" : ` (${label})`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function Layout({
  context,
  keybindings,
  modes,
}: {
  context: PluginContext;
  keybindings: Keybindings | undefined;
  modes: Modes | undefined;
}) {
  const { current } = useModes(modes);
  // Without modes (or before one registers), the page is Threads mode's slots (D743).
  const sidebarSlot = current?.sidebarSlot ?? "app.sidebar";
  const mainSlot = current?.mainSlot ?? "app.main";
  const appearance = useConfig<Appearance>(context, APPEARANCE_SECTION);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    applyAppearance(appearance, false);
    if (appearance.mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(appearance, false);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [appearance]);
  const maxWidth = maximumSidebarWidth(viewport);

  return (
    <SidebarProvider
      className="h-dvh! min-h-0!"
      style={
        {
          "--sidebar-width": `${Math.min(sidebarWidth, maxWidth)}px`,
        } as CSSProperties
      }
    >
      <SidebarHandle />
      <Sidebar
        aria-label="Sidebar"
        collapsible="offcanvas"
        data-app-sidebar=""
        resizable={{
          maxWidth,
          minWidth: SIDEBAR_MIN_WIDTH,
          onResize: setSidebarWidth,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth || wrapper.clientWidth - nextWidth >= MAIN_CONTENT_MIN_WIDTH,
          storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
        }}
        role="navigation"
        side="left"
      >
        <Slot key={sidebarSlot} name={sidebarSlot} />
        {/* The mode switcher's place (D746), filled by `jhin.mode-switcher`. */}
        <Slot name="app.sidebar.modes" />
        <SidebarRail
          onDoubleClick={() => {
            localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
            setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
          }}
        />
      </Sidebar>
      <SidebarInset
        className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
        data-mode={current?.id}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <Slot key={mainSlot} name={mainSlot} />
            <Slot name="app.overlay" />
          </div>
          <Slot name="app.panel" />
        </div>
      </SidebarInset>
      <SidebarControl keybindings={keybindings} />
      <Slot name="app.global" />
    </SidebarProvider>
  );
}

/**
 * The UI host: owns the page and its top-level slots. Everything visible is a
 * contribution of some plugin:
 * - `app.sidebar`  the left column (resizable, collapsible) in Threads mode
 * - `app.main`     the main view in Threads mode
 * Other modes (`client.modes@1`, D742) bring their own two slots instead.
 * - `app.overlay`  panels over the main view
 * - `app.panel`    a panel docked right of the main view
 * - `app.global`   overlays of the whole page (palettes, dialogs)
 */
export const uiHostPlugin = builtin(
  "jhin.ui-react",
  {
    provides: {
      [UI_SLOTS_CAPABILITY]: "1.0.0",
      [UI_TOASTS_CAPABILITY]: "1.0.0",
      [UI_DIALOGS_CAPABILITY]: "1.0.0",
    },
    requires: { [SETTINGS_CAPABILITY]: "^1" },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1", [MODES_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const registry = createSlotRegistry({
        onError: (id, error) =>
          context.log.error("contribution failed to render", {
            contribution: id,
            error: String(error),
          }),
      });
      const toasts = createToasts();
      const dialogs = createDialogs();
      context.services.provide(UI_SLOTS_CAPABILITY, registry);
      context.services.provide(UI_TOASTS_CAPABILITY, toasts);
      context.services.provide(UI_DIALOGS_CAPABILITY, dialogs);
      context.config.define(UI_CONFIG_SECTION, UiConfig);
      context.config.define(APPEARANCE_SECTION, Appearance);
      registry.setRules(context.config.get<UiConfig>(UI_CONFIG_SECTION));
      context.config.onDidChange<UiConfig>(UI_CONFIG_SECTION, (rules) => registry.setRules(rules));
      const settings = context.services.get<DeviceSettings>(SETTINGS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const clientModes = context.services.tryGet<Modes>(MODES_CAPABILITY);

      context.commands.register({
        name: "ui.sidebar.toggle",
        title: "Toggle sidebar",
        description: "Shows or hides the left sidebar",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          sidebarHandle.toggle?.();
          return {};
        },
      });
      const modes = ["system", "light", "dark"] as const;
      const modeLabel = { system: "System", light: "Light", dark: "Dark" } as const;
      context.commands.register({
        name: "ui.appearance.set",
        title: "Change appearance",
        description: "Sets the color mode: light, dark, or following the system",
        input: z.object({ mode: z.enum(modes) }),
        output: z.object({ mode: z.enum(modes) }),
        handler: ({ mode }) => {
          settings.patch(APPEARANCE_SECTION, { mode });
          return { mode };
        },
      });
      context.commands.register({
        name: "ui.appearance.cycle",
        title: "Cycle appearance",
        description: "Switches system → light → dark",
        input: z.object({}),
        output: z.object({ mode: z.enum(modes) }),
        handler: () => {
          const current = context.config.get<Appearance>(APPEARANCE_SECTION).mode;
          const mode = modes[(modes.indexOf(current) + 1) % modes.length]!;
          settings.patch(APPEARANCE_SECTION, { mode });
          toasts.show({
            id: "appearance-cycle",
            title: `Appearance: ${modeLabel[mode]}`,
            timeout: 1500,
          });
          return { mode };
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+b", command: "ui.sidebar.toggle" },
            { key: "mod+alt+shift+a", command: "ui.appearance.cycle", when: "!terminalFocus" },
          ]),
        );
      }

      applyAppearance(context.config.get<Appearance>(APPEARANCE_SECTION), false);
      const root = createRoot(document.getElementById("root")!);
      root.render(
        <SlotsProvider registry={registry}>
          <ToastProvider>
            <Layout context={context} keybindings={keybindings} modes={clientModes} />
            <DialogHost dialogs={dialogs} />
          </ToastProvider>
        </SlotsProvider>,
      );
      context.subscriptions.add({ dispose: () => root.unmount() });
    },
  }),
);
