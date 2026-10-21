// The palette follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/CommandPalette.tsx,
// CommandPaletteContent.tsx, CommandPaletteResults.tsx and EnvironmentMachineIcon.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MACHINES_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeMachines,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
  Kbd,
  KbdGroup,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BotIcon,
  BugIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  HashIcon,
  LockIcon,
  MessageSquareDashedIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PencilRulerIcon,
  SettingsIcon,
  SquareIcon,
  SquarePenIcon,
  SunIcon,
  TerminalSquareIcon,
  TextCursorInputIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { builtin } from "../lib/builtin.ts";
import { formatRelativeTimeLabel } from "../lib/format.ts";
import { useExternal, useNow } from "../lib/hooks.ts";
import { MachineIcon } from "../lib/machine-icon.tsx";
import { useMachineKind } from "../lib/machines.ts";
import { filterSearchGroups, type SearchGroup } from "../lib/palette-search.ts";
import { SearchMatchExcerpt } from "../lib/thread-search-match.tsx";
import {
  contentQuery,
  createContentSearch,
  searchingContents,
  type ContentMatch,
  type ContentSearchState,
} from "../lib/thread-search.ts";
import { ProjectIcon } from "../lib/project-icon.tsx";

interface PaletteItem {
  readonly value: string;
  readonly title: ReactNode;
  readonly description?: string;
  /** Leads the description, e.g. the machine icon of the node it names. */
  readonly descriptionIcon?: ReactNode;
  readonly icon: ReactNode;
  readonly shortcut?: string;
  readonly timestamp?: string;
  readonly searchTerms: readonly string[];
  readonly searchRecency?: number;
  /** A thread found by its messages: the excerpt that matched (D228). */
  readonly contentMatch?: ContentMatch;
  readonly trailing?: ReactNode;
  readonly keepOpen?: boolean;
  readonly run?: () => unknown;
  /** A submenu instead of an action. */
  readonly groups?: readonly SearchGroup<PaletteItem>[];
}

const ITEM_ICON_CLASS = "size-4 text-icon-muted";

/** The machine icon of a node a result names, as T3 marks a project's environment. */
function NodeIcon(props: { machines: NodeMachines | undefined; target: NodeTarget }) {
  return (
    <MachineIcon
      aria-hidden
      className="size-3 shrink-0"
      kind={useMachineKind(props.machines, props.target)}
    />
  );
}
const RECENT_THREADS = 12;

const COMMAND_ICONS: Record<string, LucideIcon> = {
  "chat.composer.focus": TextCursorInputIcon,
  "chat.model-picker.toggle": BotIcon,
  "chat.new": SquarePenIcon,
  "chat.new-without-project": MessageSquareDashedIcon,
  "chat.plan.toggle": PencilRulerIcon,
  "chat.runtime-mode.cycle": LockIcon,
  "chat.stop": SquareIcon,
  "chat.thread.copy-id": HashIcon,
  "inspector.toggle": BugIcon,
  "navigation.back": ArrowLeftIcon,
  "navigation.forward": ArrowRightIcon,
  "settings.open": SettingsIcon,
  "project.add": FolderPlusIcon,
  "sidebar.thread.next": ArrowDownIcon,
  "sidebar.thread.previous": ArrowUpIcon,
  "ui.appearance.cycle": MonitorIcon,
  "ui.sidebar.toggle": PanelLeftIcon,
};

/** Whether the palette is open; the palette plugin owns it. */
function createOpenState() {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: () => open,
    set(next: boolean) {
      if (open === next) return;
      open = next;
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

export const commandPalettePlugin = builtin(
  "jhin.command-palette",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      [MACHINES_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      /** The threads the nodes find by their messages while a query is typed (D228). */
      const contentSearch = createContentSearch(threads);
      context.subscriptions.add({ dispose: contentSearch.dispose });
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const machines = context.services.tryGet<NodeMachines>(MACHINES_CAPABILITY);
      const open = createOpenState();

      /** Every node this client reaches: connections and the reachable members of their meshes. */
      const targets = (): { target: NodeTarget; label: string }[] =>
        connections.list().flatMap((node) => [
          { target: { node: node.id }, label: node.label },
          ...(mesh.members(node.id) ?? [])
            .filter((member) => !member.self && member.reachable)
            .map((member) => ({
              target: { node: node.id, remote: member.nodeId },
              label: member.name,
            })),
        ]);
      const route = (target: NodeTarget) => ({
        node: target.node,
        ...(target.remote === undefined ? {} : { remote: target.remote }),
      });

      const actionItems = (): PaletteItem[] =>
        context.commands
          .list()
          .filter((command) => {
            if (command.title === undefined || command.name === "palette.toggle") return false;
            const required = (command.inputSchema as { required?: unknown[] } | undefined)
              ?.required;
            return required === undefined || required.length === 0;
          })
          .map((command) => {
            const Icon = COMMAND_ICONS[command.name] ?? TerminalSquareIcon;
            const shortcut = keybindings?.labelFor(command.name);
            return {
              value: `command:${command.name}`,
              title: command.title,
              icon: <Icon className={ITEM_ICON_CLASS} />,
              ...(shortcut === undefined ? {} : { shortcut }),
              searchTerms: [command.title!, command.description, command.name],
              run: () => context.commands.execute(command.name, {}),
            };
          });

      const projectItems = (): PaletteItem[] => {
        const all = targets();
        // As in the sidebar (D71), a node's icon shows only while several are reachable.
        const hosts = all.length > 1;
        return all.flatMap(({ target, label }) =>
          threads.catalog(target).projects.map((project) => ({
            value: `project:${target.node}|${target.remote ?? ""}:${project.id}`,
            title: project.name,
            description: project.scratch ? label : `${label} · ${project.path}`,
            ...(hosts ? { descriptionIcon: <NodeIcon machines={machines} target={target} /> } : {}),
            icon: <ProjectIcon className="size-4" project={project} />,
            searchTerms: [project.name, project.path, label],
            run: () => navigation.navigate({ ...route(target), project: project.id }),
          })),
        );
      };

      const threadItems = (
        now: number,
        content?: ContentSearchState,
        query = "",
      ): PaletteItem[] => {
        const current = navigation.current();
        // Only matches of the query typed now: a previous query's snippets would rank stale.
        const fresh =
          content !== undefined && content.query === contentQuery(query) ? content : undefined;
        const matchOf = (target: NodeTarget, threadId: string) =>
          fresh?.matches.find(
            (match) => match.threadId === threadId && targetKey(match.target) === targetKey(target),
          );
        return targets()
          .flatMap(({ target, label }) => {
            const catalog = threads.catalog(target);
            return catalog.threads
              .filter((thread) => thread.archivedAt === undefined)
              .map((thread) => {
                const project = catalog.projects.find((item) => item.id === thread.projectId);
                const at = thread.lastTurn?.at ?? thread.updatedAt ?? thread.createdAt;
                const contentMatch = matchOf(target, thread.id);
                const isCurrent =
                  current.thread === thread.id &&
                  current.node === target.node &&
                  current.remote === target.remote;
                return {
                  value: `thread:${target.node}|${target.remote ?? ""}:${thread.id}`,
                  title: thread.title,
                  description: [project?.name, label, isCurrent ? "Current thread" : undefined]
                    .filter(Boolean)
                    .join(" · "),
                  icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
                  timestamp: formatRelativeTimeLabel(at, now),
                  searchRecency: Date.parse(at),
                  searchTerms: [
                    thread.title,
                    project?.name ?? "",
                    label,
                    contentMatch?.snippet ?? "",
                    thread.id,
                  ],
                  ...(contentMatch === undefined ? {} : { contentMatch }),
                  run: () => navigation.navigate({ ...route(target), thread: thread.id }),
                } satisfies PaletteItem;
              });
          })
          .toSorted((a, b) => (b.searchRecency ?? 0) - (a.searchRecency ?? 0));
      };

      const submenus = (): PaletteItem[] => [
        {
          value: "submenu:new-thread-in",
          title: "New thread in...",
          icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
          searchTerms: ["New thread in", "project"],
          groups: [{ value: "projects", label: "Projects", items: projectItems() }],
        },
        {
          value: "submenu:appearance",
          title: "Change appearance",
          icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
          searchTerms: ["Change appearance", "theme", "dark", "light", "system"],
          groups: [
            {
              value: "appearance",
              label: "Appearance",
              items: (
                [
                  ["system", "System", MonitorIcon],
                  ["light", "Light", SunIcon],
                  ["dark", "Dark", MoonIcon],
                ] as const
              ).map(([mode, title, Icon]) => ({
                value: `appearance:${mode}`,
                title,
                icon: <Icon className={ITEM_ICON_CLASS} />,
                searchTerms: [title],
                run: () => context.commands.execute("ui.appearance.set", { mode }),
              })),
            },
          ],
        },
      ];

      /**
       * The groups shown before a submenu is entered. They read the stores
       * directly; `revision` changes with those stores (see `useRevision`),
       * so a memoized render rebuilds them instead of showing stale items.
       */
      const rootGroups = (
        query: string,
        _revision: number,
        now: number,
        content: ContentSearchState,
      ): SearchGroup<PaletteItem>[] => {
        const actions: SearchGroup<PaletteItem> = {
          value: "actions",
          label: "Actions",
          items: [...actionItems(), ...submenus()],
        };
        if (query.trim() === "") {
          return [
            actions,
            {
              value: "recent-threads",
              label: "Recent Threads",
              items: threadItems(now).slice(0, RECENT_THREADS),
            },
          ];
        }
        return [
          actions,
          { value: "projects-search", label: "Projects", items: projectItems() },
          { value: "threads-search", label: "Threads", items: threadItems(now, content, query) },
        ];
      };

      const reached = () =>
        targets()
          .map(({ target }) => targetKey(target))
          .join("\n");

      /**
       * Changes whenever what the items are built from does: the nodes reached
       * (connections and their meshes) and their catalogs, the place, the
       * shortcuts, and plugins coming and going with their commands. A change
       * of the nodes reached follows the new ones.
       */
      function useRevision(): number {
        const [revision, setRevision] = useState(0);
        const [nodes, setNodes] = useState(reached);
        useEffect(() => {
          const bump = () => setRevision((value) => value + 1);
          const follow = () => {
            setNodes(reached());
            bump();
          };
          const subscriptions = [
            connections.subscribe(follow),
            ...connections.list().map((node) => mesh.subscribe(node.id, follow)),
            ...targets().map(({ target }) => threads.subscribe(target, bump)),
            navigation.subscribe(bump),
            ...(keybindings === undefined ? [] : [keybindings.subscribe(bump)]),
            context.events.on("kernel.plugin.activated", bump),
            context.events.on("kernel.plugin.deactivated", bump),
          ];
          return () => subscriptions.forEach((subscription) => subscription.dispose());
        }, [nodes]);
        return revision;
      }

      function PaletteBody() {
        const revision = useRevision();
        const now = useNow();
        const [query, setQuery] = useState("");
        const [stack, setStack] = useState<readonly PaletteItem[]>([]);
        const [highlighted, setHighlighted] = useState<string | null>(null);
        const submenu = stack.at(-1);
        // The nodes search their threads' messages too (T3's useThreadSearch).
        const content = useExternal(contentSearch, contentSearch.get);
        const searchQuery = submenu === undefined && !query.startsWith(">") ? query : "";
        // Only nodes behind an open connection can answer, as the sidebar asks them; one
        // that opens or closes while a query is typed is asked, or left, at once.
        const connected = useExternal(connections, connections.list);
        const openKey = connected
          .filter((node) => node.state === "open")
          .map((node) => node.id)
          .join(" ");
        useEffect(() => {
          const open = new Set(openKey.split(" "));
          contentSearch.request(
            searchQuery,
            targets()
              .filter(({ target }) => open.has(target.node))
              .map(({ target }) => target),
          );
        }, [searchQuery, revision, openKey]);
        useEffect(() => () => contentSearch.request("", []), []);
        const base = submenu?.groups ?? rootGroups(query, revision, now, content);
        const groups = filterSearchGroups(base, query);
        const items = groups.flatMap((group) => group.items);

        const execute = (item: PaletteItem) => {
          if (item.groups !== undefined) {
            setStack([...stack, item]);
            setQuery("");
            setHighlighted(null);
            return;
          }
          if (item.keepOpen !== true) open.set(false);
          void Promise.resolve()
            .then(() => item.run?.())
            .catch((error: unknown) =>
              toasts?.show({
                type: "error",
                title: "Unable to run command",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              }),
            );
        };

        return (
          <Command
            items={groups}
            mode="none"
            onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
            onValueChange={(value) => setQuery(String(value))}
            value={query}
          >
            <div className="relative">
              <CommandInput
                aria-label="Search commands"
                onKeyDown={(event) => {
                  if (event.key === "Backspace" && query === "" && stack.length > 0) {
                    event.preventDefault();
                    setStack(stack.slice(0, -1));
                    return;
                  }
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    const item =
                      items.find((candidate) => candidate.value === highlighted) ?? items[0];
                    if (item !== undefined) {
                      event.preventDefault();
                      execute(item);
                    }
                  }
                }}
                placeholder={
                  submenu === undefined ? "Search commands, projects, and threads..." : "Search..."
                }
                {...(submenu === undefined
                  ? {}
                  : {
                      startAddon: (
                        <button
                          aria-label="Back"
                          className="flex cursor-pointer items-center"
                          onClick={() => setStack(stack.slice(0, -1))}
                          type="button"
                        >
                          <ArrowLeftIcon />
                        </button>
                      ),
                    })}
              />
            </div>
            <CommandPanel className="flex max-h-[min(28rem,70vh)] min-h-0 flex-col">
              {groups.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  {query.startsWith(">")
                    ? "No matching actions."
                    : searchingContents(content, searchQuery)
                      ? "Searching thread messages…"
                      : "No matching commands, projects, or threads."}
                </div>
              ) : (
                <CommandList className="overflow-y-auto">
                  {groups.map((group) => (
                    <CommandGroup items={group.items} key={group.value}>
                      <CommandGroupLabel>{group.label}</CommandGroupLabel>
                      <CommandCollection>
                        {(item: PaletteItem) => (
                          <CommandItem
                            key={item.value}
                            onClick={() => execute(item)}
                            onMouseDown={(event) => event.preventDefault()}
                            value={item.value}
                          >
                            {item.icon}
                            {item.description === undefined ? (
                              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
                                <span className="truncate">{item.title}</span>
                              </span>
                            ) : (
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                                  <span className="truncate">{item.title}</span>
                                </span>
                                <span className="flex min-w-0 items-center gap-1 text-muted-foreground/70 text-xs">
                                  {item.descriptionIcon}
                                  <span className="min-w-0 truncate">{item.description}</span>
                                </span>
                                {item.contentMatch === undefined ? null : (
                                  <SearchMatchExcerpt match={item.contentMatch} query={query} />
                                )}
                              </span>
                            )}
                            {item.trailing}
                            {item.timestamp === undefined ? null : (
                              <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
                                {item.timestamp}
                              </span>
                            )}
                            {item.shortcut === undefined ? null : (
                              <CommandShortcut>{item.shortcut}</CommandShortcut>
                            )}
                            {item.groups === undefined ? null : (
                              <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
                            )}
                          </CommandItem>
                        )}
                      </CommandCollection>
                    </CommandGroup>
                  ))}
                </CommandList>
              )}
            </CommandPanel>
            <CommandFooter className="max-sm:flex-col max-sm:items-start">
              <div className="flex items-center gap-3">
                <KbdGroup>
                  <Kbd>
                    <ArrowUpIcon />
                  </Kbd>
                  <Kbd>
                    <ArrowDownIcon />
                  </Kbd>
                  <span>Navigate</span>
                </KbdGroup>
                <KbdGroup>
                  <Kbd>Enter</Kbd>
                  <span>Select</span>
                </KbdGroup>
                {stack.length > 0 ? (
                  <KbdGroup>
                    <Kbd>Backspace</Kbd>
                    <span>Back</span>
                  </KbdGroup>
                ) : null}
                <KbdGroup>
                  <Kbd>Esc</Kbd>
                  <span>Close</span>
                </KbdGroup>
              </div>
            </CommandFooter>
          </Command>
        );
      }

      function Palette() {
        const isOpen = useExternal(open, open.get);
        return (
          <CommandDialog onOpenChange={(next) => open.set(next)} open={isOpen}>
            {isOpen ? (
              <CommandDialogPopup
                aria-label="Command palette"
                className="overflow-hidden"
                data-command-palette="true"
                onBackdropPointerDown={() => open.set(false)}
              >
                <PaletteBody />
              </CommandDialogPopup>
            ) : null}
          </CommandDialog>
        );
      }

      context.commands.register({
        name: "palette.toggle",
        title: "Command palette",
        description: "Opens or closes the command palette",
        input: z.object({}),
        output: z.object({ open: z.boolean() }),
        handler: () => {
          open.set(!open.get());
          return { open: open.get() };
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+k", command: "palette.toggle", when: "!terminalFocus" },
          ]),
        );
      }
      context.subscriptions.add(
        slots.contribute("app.global", { id: "jhin.command-palette", component: Palette }),
      );
    },
  }),
);
