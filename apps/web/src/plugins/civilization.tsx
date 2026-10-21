import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Keybindings,
  type Modes,
  type Navigation,
} from "@jhin/client-api";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Kbd,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  Slot,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_SLOTS_CAPABILITY,
  useSlot,
  type SlotRegistry,
} from "@jhin/ui";
import {
  BotIcon,
  FolderKanbanIcon,
  HeartPulseIcon,
  InboxIcon,
  LandmarkIcon,
  MessageCircleIcon,
  SettingsIcon,
  TargetIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { builtin } from "../lib/builtin.ts";
import { useConfig, useExternal, useShortcutLabels } from "../lib/hooks.ts";

/** The id of Civilization mode (D741). */
const CIVILIZATION_MODE = "civilization";

/** The `jhin.civilization` config section (D747). */
const CIVILIZATION_SECTION = "jhin.civilization";
export const CivilizationConfig = z
  .object({
    enabled: z.enum(["auto", "on", "off"]).default("auto").meta({
      title: "Civilization mode",
      description:
        "auto: offered once a connected node has persistent agents (agents.catalog); on: always; off: never.",
    }),
  })
  .meta({
    title: "Civilization",
    description: "The client's mode for long projects run by agent teams (docs/plans/agents.md).",
  });
export type CivilizationConfig = z.output<typeof CivilizationConfig>;

/** The command whose presence on a node means it has persistent agents (A1, D747). */
const AGENTS_COMMAND = "agents.catalog";

/**
 * The sections of the Civilization sidebar (D749), each a slot the owning
 * workstream fills. Until it does, the section says who fills it.
 */
const SIDEBAR_SECTIONS: readonly {
  readonly slot: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly empty: string;
}[] = [
  {
    slot: "civilization.sidebar.projects",
    title: "Projects",
    icon: FolderKanbanIcon,
    empty: "Projects run as civilizations, with their intent, arrive with missions (A3).",
  },
  {
    slot: "civilization.sidebar.inbox",
    title: "Inbox",
    icon: InboxIcon,
    empty: "What agents ask you lands here once messaging (A2) does.",
  },
  {
    slot: "civilization.sidebar.missions",
    title: "Missions",
    icon: TargetIcon,
    empty: "Missions and their slices arrive with A3.",
  },
  {
    slot: "civilization.sidebar.teams",
    title: "Teams",
    icon: UsersIcon,
    empty: "Teams arrive with A5.",
  },
  {
    slot: "civilization.sidebar.agents",
    title: "Agents",
    icon: BotIcon,
    empty: "The roster of agents arrives with A1.",
  },
  {
    slot: "civilization.sidebar.health",
    title: "Health",
    icon: HeartPulseIcon,
    empty: "Health warnings arrive with A7.",
  },
];

/** Panels of the route that are the whole app's, not a mode's (D748): Threads mode's main area shows them. */
const APP_PANELS = new Set(["settings", "connect"]);

function SectionEmpty({ text }: { text: string }) {
  return <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">{text}</p>;
}

function SidebarSection({ section }: { section: (typeof SIDEBAR_SECTIONS)[number] }) {
  const filled = useSlot(section.slot).length > 0;
  const Icon = section.icon;
  return (
    <SidebarGroup aria-label={section.title} data-civilization-section={section.slot} role="region">
      <div className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span>{section.title}</span>
      </div>
      {filled ? <Slot name={section.slot} /> : <SectionEmpty text={section.empty} />}
    </SidebarGroup>
  );
}

/**
 * `jhin.civilization`: the Civilization shell (D741, D747–D750). It adds the
 * mode, its sidebar sections and main area as slots, with empty states that
 * name the workstream that fills each. It shows no data of its own.
 */
export const civilizationPlugin = builtin(
  "jhin.civilization",
  {
    requires: {
      [MODES_CAPABILITY]: "^1",
      [UI_SLOTS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
    },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const modes = context.services.get<Modes>(MODES_CAPABILITY);
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      context.config.define(CIVILIZATION_SECTION, CivilizationConfig);

      // --- Whether to offer the mode (D747) ----------------------------------
      /** Connections whose node has agents, as last asked while it was open. */
      const withAgents = new Map<string, boolean>();
      const asked = new Set<string>();
      let registration: Disposable | undefined;
      const update = () => {
        const { enabled } = context.config.get<CivilizationConfig>(CIVILIZATION_SECTION);
        const open = connections.list().filter((connection) => connection.state === "open");
        // Ask each node once per time it opens: plugins may have changed while it was away.
        for (const id of asked) {
          if (!open.some((connection) => connection.id === id)) asked.delete(id);
        }
        if (enabled === "auto") {
          for (const connection of open) {
            if (asked.has(connection.id)) continue;
            asked.add(connection.id);
            void connection.client
              .call<readonly { name: string }[]>("host.commands.list", {})
              .then(
                (commands) =>
                  withAgents.set(
                    connection.id,
                    commands.some((command) => command.name === AGENTS_COMMAND),
                  ),
                () => withAgents.set(connection.id, false),
              )
              .then(update);
          }
        }
        const offered =
          enabled === "on" ||
          (enabled === "auto" && open.some((connection) => withAgents.get(connection.id) === true));
        if (offered && registration === undefined) {
          registration = modes.register({
            id: CIVILIZATION_MODE,
            title: "Civilization",
            description: "Long projects run by agent teams: steer through the lead and missions",
            order: 100,
            icon: LandmarkIcon,
            sidebarSlot: "civilization.sidebar",
            mainSlot: "civilization.main",
          });
        } else if (!offered && registration !== undefined) {
          registration.dispose();
          registration = undefined;
        }
      };
      context.subscriptions.add(connections.subscribe(update));
      context.config.onDidChange(CIVILIZATION_SECTION, update);
      context.subscriptions.add({ dispose: () => registration?.dispose() });
      update();

      // --- The shell (D749, D750) --------------------------------------------
      function CivilizationSidebar() {
        const shortcut = useShortcutLabels(keybindings);
        const route = useExternal(navigation, navigation.current);
        return (
          <>
            <div className="relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3">
              <span className="ml-[var(--workspace-titlebar-content-left)] inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
                <span className="font-semibold">Jhin</span>
                <span className="text-sidebar-muted-foreground">Civilization</span>
              </span>
            </div>
            <SidebarContent className="min-h-full">
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={route.panel === undefined}
                      onClick={() =>
                        navigation.navigate({
                          ...(route.node === undefined ? {} : { node: route.node }),
                          ...(route.remote === undefined ? {} : { remote: route.remote }),
                          mode: CIVILIZATION_MODE,
                        })
                      }
                    >
                      <MessageCircleIcon />
                      <span>Lead</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
              {SIDEBAR_SECTIONS.map((section) => (
                <SidebarSection key={section.slot} section={section} />
              ))}
            </SidebarContent>
            <SidebarFooter>
              <SidebarMenu className="flex-row items-center">
                <SidebarMenuItem className="shrink-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuButton
                          aria-label="Settings"
                          onClick={() => void context.commands.execute("settings.open", {})}
                          size="icon"
                        />
                      }
                    >
                      <SettingsIcon />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      Settings
                      {shortcut("settings.open") === undefined
                        ? ""
                        : ` (${shortcut("settings.open")})`}
                    </TooltipPopup>
                  </Tooltip>
                </SidebarMenuItem>
                <Slot name="civilization.sidebar.footer" />
                <SidebarMenuItem className="ms-auto shrink-0">
                  <button
                    aria-label="Command palette"
                    className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-2xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
                    onClick={() => void context.commands.execute("palette.toggle", {})}
                    type="button"
                  >
                    <Kbd>{shortcut("palette.toggle") ?? "⌘K"}</Kbd>
                  </button>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          </>
        );
      }

      function MainEmpty({ title, text }: { title: string; text: string }) {
        return (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LandmarkIcon />
              </EmptyMedia>
              <EmptyTitle>{title}</EmptyTitle>
              <EmptyDescription>{text}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        );
      }

      function Lead() {
        const filled = useSlot("civilization.lead").length > 0;
        if (filled) return <Slot name="civilization.lead" />;
        return (
          <MainEmpty
            text="You steer a civilization by talking to its lead. The conversation arrives with agents (A1) and their messages (A2); teams (A5) name the lead."
            title="No lead yet"
          />
        );
      }

      function Views() {
        const filled = useSlot("civilization.views").length > 0;
        if (filled) return <Slot name="civilization.views" />;
        return <MainEmpty text="Nothing shows this view yet." title="Nothing here" />;
      }

      function CivilizationMain() {
        const route = useExternal(navigation, navigation.current);
        const nodes = useExternal(connections, connections.list);
        // Settings and connecting are the app's pages, in every mode (D748).
        if (nodes.length === 0 || (route.panel !== undefined && APP_PANELS.has(route.panel))) {
          return <Slot name="app.main" />;
        }
        return (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-civilization-main="">
            {route.panel === undefined ? <Lead /> : <Views />}
          </div>
        );
      }

      context.subscriptions.add(
        slots.contribute("civilization.sidebar", {
          id: "jhin.civilization.sidebar",
          component: CivilizationSidebar,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.main", {
          id: "jhin.civilization.main",
          component: CivilizationMain,
        }),
      );
    },
  }),
);
