// The settings page follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/routes/settings.tsx,
// apps/web/src/components/settings/SettingsSidebarNav.tsx and settingsLayout.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MACHINES_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeMachines,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import {
  Button,
  UI_DIALOGS_CAPABILITY,
  UI_SETTINGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  cn,
  type Dialogs,
  type SettingsOutline,
  type SettingsPages,
  type SettingsSectionDefinition,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  KeyboardIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
} from "react";

import { builtin } from "../../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { prefetchWhenIdle } from "../../lib/idle-prefetch.ts";
import { useExternal } from "../../lib/hooks.ts";

export interface SettingsServices {
  readonly context: Parameters<NonNullable<Parameters<typeof definePlugin>[0]["activate"]>>[0];
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly mesh: MeshMembership;
  readonly threads: ThreadsCatalog;
  readonly machines: NodeMachines | undefined;
  readonly settings: DeviceSettings;
  readonly keybindings: Keybindings | undefined;
  readonly toasts: Toasts | undefined;
  readonly dialogs: Dialogs | undefined;
}

// Each section is a chunk of its own, loaded when it first opens (T3 splits its settings routes, D440).
const lazySection = <P extends object>(load: () => Promise<ComponentType<P>>) =>
  lazyChunk(load, {
    loading: () => null,
    failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load this section.</ChunkFailed>,
  });
const GeneralSection = lazySection(() => import("./general.tsx").then((m) => m.GeneralSection));
const AppearanceSection = lazySection(() =>
  import("./general.tsx").then((m) => m.AppearanceSection),
);
const KeybindingsSection = lazySection(() =>
  import("./keybindings.tsx").then((m) => m.KeybindingsSection),
);
const NodesSection = lazySection(() => import("./nodes.tsx").then((m) => m.NodesSection));
const ClientsSection = lazySection(() => import("./clients.tsx").then((m) => m.ClientsSection));
const NodeConfigSection = lazySection(() =>
  import("./node-config.tsx").then((m) => m.NodeConfigSection),
);
const ArchivedSection = lazySection(() => import("./archived.tsx").then((m) => m.ArchivedSection));

const SettingsContext = createContext<SettingsServices | undefined>(undefined);

export function useSettingsServices(): SettingsServices {
  const services = useContext(SettingsContext);
  if (services === undefined) throw new Error("useSettingsServices needs the settings page");
  return services;
}

/** The registered sections, in display order. */
function createSections() {
  let sections: SettingsSectionDefinition[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    add(section: SettingsSectionDefinition) {
      if (sections.some((item) => item.id === section.id)) {
        throw new Error(`A settings section ${section.id} already exists`);
      }
      sections = [...sections, section].toSorted(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label),
      );
      changed();
      return toDisposable(() => {
        sections = sections.filter((item) => item !== section);
        changed();
      });
    },
    list: () => sections,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The outline each open section contributes (config-ui.md D1629). */
function createOutlines() {
  let outlines = new Map<string, SettingsOutline>();
  const listeners = new Set<() => void>();
  return {
    set(section: string, outline: SettingsOutline) {
      outlines = new Map(outlines).set(section, outline);
      for (const listener of Array.from(listeners)) listener();
      return toDisposable(() => {
        if (outlines.get(section) !== outline) return;
        outlines = new Map(outlines);
        outlines.delete(section);
        for (const listener of Array.from(listeners)) listener();
      });
    },
    all: () => outlines,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const settingsPlugin = builtin(
  "jhin.settings",
  {
    // 1.1: `setOutline` (config-ui.md D1629).
    provides: { [UI_SETTINGS_CAPABILITY]: "1.1.0" },
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [SETTINGS_CAPABILITY]: "^1",
    },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [MACHINES_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const services: SettingsServices = {
        context,
        connections: context.services.get<Connections>(CONNECTIONS_CAPABILITY),
        navigation,
        mesh,
        threads,
        machines: context.services.tryGet<NodeMachines>(MACHINES_CAPABILITY),
        settings: context.services.get<DeviceSettings>(SETTINGS_CAPABILITY),
        keybindings,
        toasts,
        dialogs,
      };
      const sections = createSections();
      const outlines = createOutlines();
      // The section the page opens on is fetched while the page is idle (D1596).
      context.subscriptions.add(prefetchWhenIdle(GeneralSection.preload));

      const open = (section?: string) => {
        const { section: _section, anchor: _anchor, ...route } = navigation.current();
        navigation.navigate({
          ...route,
          panel: "settings",
          ...(section === undefined ? {} : { section }),
        });
      };
      const close = () => {
        const { panel: _panel, section: _section, anchor: _anchor, ...rest } = navigation.current();
        navigation.navigate(rest);
      };
      /** Leaves the shown section once its page lets it go (D1629). */
      const leave = (then: () => void) => {
        const route = navigation.current();
        const shown = route.section ?? sections.list()[0]?.id;
        const outline = shown === undefined ? undefined : outlines.all().get(shown);
        if (outline?.confirmLeave === undefined) return then();
        void outline.confirmLeave().then((ok) => {
          if (ok) then();
        });
      };
      const pages: SettingsPages = {
        addSection: (section) => sections.add(section),
        open,
        setOutline: (section, outline) => outlines.set(section, outline),
      };
      context.services.provide(UI_SETTINGS_CAPABILITY, pages);

      for (const section of [
        {
          id: "general",
          label: "General",
          icon: Settings2Icon,
          order: 0,
          component: GeneralSection,
        },
        {
          id: "appearance",
          label: "Appearance",
          icon: PaletteIcon,
          order: 10,
          component: AppearanceSection,
        },
        {
          id: "keybindings",
          label: "Keybindings",
          icon: KeyboardIcon,
          order: 30,
          component: KeybindingsSection,
        },
        { id: "nodes", label: "Nodes", icon: ServerIcon, order: 40, component: NodesSection },
        {
          id: "authorized-clients",
          label: "Authorized clients",
          icon: KeyRoundIcon,
          order: 45,
          component: ClientsSection,
        },
        {
          id: "node-config",
          label: "Node config",
          icon: SlidersHorizontalIcon,
          order: 50,
          component: NodeConfigSection,
        },
        {
          id: "archived",
          label: "Archived threads",
          icon: ArchiveIcon,
          order: 90,
          component: ArchivedSection,
        },
      ] satisfies SettingsSectionDefinition[]) {
        context.subscriptions.add(sections.add(section));
      }

      function SettingsPage() {
        const route = useExternal(navigation, navigation.current);
        const list = useSyncExternalStore(sections.subscribe, sections.list);
        useEffect(() => {
          if (route.panel !== "settings") return;
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest("input, textarea, [role=dialog], [data-keybinding-capture]"))
              return;
            leave(close);
          };
          window.addEventListener("keydown", onKeyDown);
          return () => window.removeEventListener("keydown", onKeyDown);
        }, [route.panel]);
        const current = list.find((section) => section.id === route.section) ?? list[0];
        const Section = current?.component;
        const outline = useSyncExternalStore(outlines.subscribe, outlines.all).get(
          current?.id ?? "",
        );
        const anchorOf = (id: string) => id.slice((current?.id.length ?? 0) + 1);
        /** The outline whose anchor was selected already: once per outline (D1629). */
        const anchored = useRef<string | undefined>(undefined);
        const entries = outline?.entries ?? [];
        const anchorEntry = entries.find((entry) => anchorOf(entry.id) === route.anchor)?.id;
        useEffect(() => {
          if (route.panel !== "settings" || outline === undefined || current === undefined) {
            anchored.current = undefined;
            return;
          }
          if (anchored.current !== current.id) {
            if (entries.length === 0) return;
            anchored.current = current.id;
            if (anchorEntry !== undefined) {
              outline.select(anchorEntry);
              return;
            }
          }
          // The route names the entry in view, without a history entry of its own (D1628).
          const anchor = outline.current === undefined ? undefined : anchorOf(outline.current);
          if (anchor === route.anchor) return;
          const { anchor: _anchor, ...rest } = navigation.current();
          navigation.navigate(anchor === undefined ? rest : { ...rest, anchor }, {
            replace: true,
          });
        }, [route.panel, outline, current?.id, entries.length, anchorEntry, route.anchor]);
        if (route.panel !== "settings") return null;
        const jump = (id: string) => {
          outline?.select(id);
          const { anchor: _anchor, ...rest } = navigation.current();
          navigation.navigate({ ...rest, anchor: anchorOf(id) }, { replace: true });
        };
        return (
          <SettingsContext.Provider value={services}>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
              <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) wco:pr-(--workspace-native-controls-inset) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]">
                <nav
                  aria-label="Settings breadcrumb"
                  className="flex min-w-0 items-center gap-2 text-sm sm:gap-3"
                >
                  <button
                    className="cursor-pointer font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => leave(() => open())}
                    type="button"
                  >
                    Settings
                  </button>
                  <span aria-hidden className="text-icon-muted">
                    /
                  </span>
                  <span className="truncate font-medium text-foreground">{current?.label}</span>
                </nav>
                <div className="ms-auto flex shrink-0 items-center">
                  <Button onClick={() => leave(close)} size="xs" variant="ghost">
                    <ArrowLeftIcon className="mx-0.5 size-3.5" />
                    Back
                  </Button>
                </div>
              </header>
              <div className="flex min-h-0 flex-1">
                <nav
                  aria-label="Settings sections"
                  className="hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 p-2 md:flex"
                >
                  {list.map((section) => {
                    const Icon = section.icon;
                    const active = section.id === current?.id;
                    return (
                      <div className="flex flex-col gap-0.5" key={section.id}>
                        <button
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-2.5 text-left text-sm font-medium text-muted-foreground/80 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            active && "bg-accent text-foreground",
                          )}
                          onClick={() => (active ? undefined : leave(() => open(section.id)))}
                          type="button"
                        >
                          {Icon === undefined ? null : (
                            <Icon className="size-4 shrink-0 text-icon-muted" />
                          )}
                          <span className="truncate">{section.label}</span>
                        </button>
                        {active && entries.length > 0 ? (
                          <ul
                            aria-label={`${section.label} outline`}
                            className="ms-4 flex flex-col gap-0.5 border-s border-border/60 ps-1.5"
                          >
                            {entries.map((entry) => (
                              <li key={entry.id}>
                                <button
                                  aria-current={
                                    entry.id === outline?.current ? "location" : undefined
                                  }
                                  className={cn(
                                    "flex h-7 w-full cursor-pointer items-center rounded-[var(--control-radius)] px-2 text-left text-xs text-muted-foreground/80 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                    entry.id === outline?.current && "font-medium text-foreground",
                                  )}
                                  onClick={() => jump(entry.id)}
                                  title={entry.hint}
                                  type="button"
                                >
                                  <span className="truncate">{entry.label}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </nav>
                <div
                  className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
                  data-settings-page-scroll
                >
                  <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 pt-6 pb-12 sm:px-6">
                    <div className="flex gap-1 overflow-x-auto md:hidden">
                      {list.map((section) => (
                        <Button
                          key={section.id}
                          onClick={() =>
                            section.id === current?.id ? undefined : leave(() => open(section.id))
                          }
                          size="xs"
                          variant={section.id === current?.id ? "secondary" : "ghost"}
                        >
                          {section.label}
                        </Button>
                      ))}
                    </div>
                    {entries.length === 0 ? null : (
                      // Where the navigation folds away, the outline is a menu (D1623).
                      <div className="sticky top-0 z-10 -my-4 bg-background py-2 md:hidden">
                        <Menu>
                          <MenuTrigger render={<Button size="xs" variant="outline" />}>
                            Jump to section
                            <ChevronDownIcon className="size-3.5" />
                          </MenuTrigger>
                          <MenuPopup align="start">
                            {entries.map((entry) => (
                              <MenuItem key={entry.id} onClick={() => jump(entry.id)}>
                                <span
                                  className={cn(entry.id === outline?.current && "font-medium")}
                                >
                                  {entry.label}
                                </span>
                                {entry.hint === undefined ? null : (
                                  <span className="ms-2 font-mono text-xs text-muted-foreground">
                                    {entry.hint}
                                  </span>
                                )}
                              </MenuItem>
                            ))}
                          </MenuPopup>
                        </Menu>
                      </div>
                    )}
                    {Section === undefined ? null : <Section key={current?.id} />}
                  </div>
                </div>
              </div>
            </div>
          </SettingsContext.Provider>
        );
      }

      context.commands.register({
        name: "settings.open",
        title: "Open settings",
        description: "Opens the settings page",
        input: z.object({ section: z.string().optional() }),
        output: z.object({}),
        handler: ({ section }) => {
          open(section);
          return {};
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+,", command: "settings.open", when: "!terminalFocus" },
          ]),
        );
      }
      context.subscriptions.add(
        slots.contribute("app.main", { id: "jhin.settings.page", component: SettingsPage }),
      );
    },
  }),
);
