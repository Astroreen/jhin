// Civilization mode's shell (D749, D750), a chunk of its own (D440): the page
// loads it once Civilization mode is shown, so the entry stays small.
import type { Connections, Keybindings, Navigation } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
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
  useSlot,
} from "@jhin/ui";
import {
  BotIcon,
  HeartPulseIcon,
  InboxIcon,
  LandmarkIcon,
  MessageCircleIcon,
  SettingsIcon,
  TargetIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { useExternal, useShortcutLabels } from "../lib/hooks.ts";
import { APP_PANELS } from "../lib/modes.ts";

/** What the shell's components use of the plugin that shows them. */
export interface CivilizationShell {
  readonly context: PluginContext;
  readonly mode: string;
  readonly navigation: Navigation;
  readonly connections: Connections;
  readonly keybindings: Keybindings | undefined;
}

/**
 * The sections of the Civilization sidebar (D749), each a slot a plugin
 * fills. Until it does, the section says in the owner's words what is empty.
 */
const SIDEBAR_SECTIONS: readonly {
  readonly slot: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly empty: string;
}[] = [
  {
    slot: "civilization.sidebar.inbox",
    title: "Inbox",
    icon: InboxIcon,
    empty: "Nothing here yet.",
  },
  {
    slot: "civilization.sidebar.missions",
    title: "Missions",
    icon: TargetIcon,
    empty: "No missions yet.",
  },
  {
    slot: "civilization.sidebar.teams",
    title: "Teams",
    icon: UsersIcon,
    empty: "No teams yet.",
  },
  {
    slot: "civilization.sidebar.agents",
    title: "Agents",
    icon: BotIcon,
    empty: "No agents yet.",
  },
  {
    slot: "civilization.sidebar.health",
    title: "Health",
    icon: HeartPulseIcon,
    empty: "No health warnings.",
  },
];

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

export function CivilizationSidebar({ shell }: { shell: CivilizationShell }) {
  const { navigation, mode } = shell;
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
                    mode,
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
          <Slot name="civilization.sidebar.footer" />
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

export function SettingsButton({ shell }: { shell: CivilizationShell }) {
  const { context, keybindings } = shell;
  const shortcut = useShortcutLabels(keybindings)("settings.open");
  return (
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
          Settings{shortcut === undefined ? "" : ` (${shortcut})`}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export function PaletteButton({ shell }: { shell: CivilizationShell }) {
  const { context, keybindings } = shell;
  const shortcut = useShortcutLabels(keybindings)("palette.toggle");
  return (
    <SidebarMenuItem className="ms-auto shrink-0">
      <button
        aria-label="Command palette"
        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-2xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
        onClick={() => void context.commands.execute("palette.toggle", {})}
        type="button"
      >
        <Kbd>{shortcut ?? "⌘K"}</Kbd>
      </button>
    </SidebarMenuItem>
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
      text="A team names its lead, the agent you talk to here. No team has one yet."
      title="No lead yet"
    />
  );
}

function Views() {
  const filled = useSlot("civilization.views").length > 0;
  if (filled) return <Slot name="civilization.views" />;
  return <MainEmpty text="Nothing shows this view yet." title="Nothing here" />;
}

export function CivilizationMain({ shell }: { shell: CivilizationShell }) {
  const { navigation, connections } = shell;
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
