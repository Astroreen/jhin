// The settings page follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/routes/settings.tsx,
// apps/web/src/components/settings/SettingsSidebarNav.tsx and settingsLayout.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import {
  Button,
  UI_DIALOGS_CAPABILITY,
  UI_SETTINGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  cn,
  type Dialogs,
  type SettingsPages,
  type SettingsSectionDefinition,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  KeyboardIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal } from "../../lib/hooks.ts";
import { ArchivedSection } from "./archived.tsx";
import { AppearanceSection, GeneralSection } from "./general.tsx";
import { KeybindingsSection } from "./keybindings.tsx";
import { NodeConfigSection } from "./node-config.tsx";
import { NodesSection } from "./nodes.tsx";

export interface SettingsServices {
  readonly context: Parameters<NonNullable<Parameters<typeof definePlugin>[0]["activate"]>>[0];
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly mesh: MeshMembership;
  readonly threads: ThreadsCatalog;
  readonly settings: DeviceSettings;
  readonly keybindings: Keybindings | undefined;
  readonly toasts: Toasts | undefined;
  readonly dialogs: Dialogs | undefined;
}

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

export const settingsPlugin = builtin(
  "jhin.settings",
  {
    provides: { [UI_SETTINGS_CAPABILITY]: "1.0.0" },
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
        settings: context.services.get<DeviceSettings>(SETTINGS_CAPABILITY),
        keybindings,
        toasts,
        dialogs,
      };
      const sections = createSections();

      const open = (section?: string) => {
        const { section: _section, ...route } = navigation.current();
        navigation.navigate({
          ...route,
          panel: "settings",
          ...(section === undefined ? {} : { section }),
        });
      };
      const close = () => {
        const { panel: _panel, section: _section, ...rest } = navigation.current();
        navigation.navigate(rest);
      };
      const pages: SettingsPages = { addSection: (section) => sections.add(section), open };
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
            close();
          };
          window.addEventListener("keydown", onKeyDown);
          return () => window.removeEventListener("keydown", onKeyDown);
        }, [route.panel]);
        if (route.panel !== "settings") return null;
        const current = list.find((section) => section.id === route.section) ?? list[0];
        const Section = current?.component;
        return (
          <SettingsContext.Provider value={services}>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
              <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]">
                <nav
                  aria-label="Settings breadcrumb"
                  className="flex min-w-0 items-center gap-2 text-sm sm:gap-3"
                >
                  <button
                    className="cursor-pointer font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => open()}
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
                  <Button onClick={close} size="xs" variant="ghost">
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
                      <button
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-2.5 text-left text-sm font-medium text-muted-foreground/80 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          active && "bg-accent text-foreground",
                        )}
                        key={section.id}
                        onClick={() => open(section.id)}
                        type="button"
                      >
                        {Icon === undefined ? null : (
                          <Icon className="size-4 shrink-0 text-icon-muted" />
                        )}
                        <span className="truncate">{section.label}</span>
                      </button>
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
                          onClick={() => open(section.id)}
                          size="xs"
                          variant={section.id === current?.id ? "secondary" : "ghost"}
                        >
                          {section.label}
                        </Button>
                      ))}
                    </div>
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
