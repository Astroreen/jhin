import type { ModelOptionDescriptor, ModelOptionSelection } from "@jhin/agent-api";
import type { MachineKind } from "@jhin/host-api";
import type { ConnectionState, RpcClient } from "@jhin/rpc";
import { z, type Disposable } from "@jhin/sdk";

export const CONNECTIONS_CAPABILITY = "client.connections";
export const NAVIGATION_CAPABILITY = "client.navigation";
export const MESH_CAPABILITY = "client.mesh";
export const THREADS_CAPABILITY = "client.threads";
export const SETTINGS_CAPABILITY = "client.settings";
export const MACHINES_CAPABILITY = "client.machines";

// The machine kinds a node reports, for client plugins (they import this package, not the host's).
export {
  HOST_CONFIG_SECTION,
  isMachineKind,
  MACHINE_KIND_LABELS,
  MACHINE_KINDS,
  SECRET_REDACTED,
  isRedactedSecret,
  type MachineKind,
} from "@jhin/host-api";

/** One node this client talks to (D8: a client holds N connections). */
export interface NodeConnection {
  /** Stable within this client: the node's RPC URL. */
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly client: RpcClient;
  readonly state: ConnectionState;
}

/** `client.connections@1`: the nodes this client is connected to. */
export interface Connections {
  list(): readonly NodeConnection[];
  get(id: string): NodeConnection | undefined;
  /** Connects to a node and remembers it on this device. */
  add(node: { url: string; token: string; label?: string }): NodeConnection;
  remove(id: string): void;
  /** Gives a connection another label on this device (1.1). */
  rename?(id: string, label: string): void;
  /** Fires when the list or any connection state changes. */
  subscribe(listener: () => void): Disposable;
}

/** One node of a connected node's mesh, as that node's `mesh.nodes` lists it. */
export interface MeshMember {
  readonly nodeId: string;
  readonly name: string;
  /** The connected node itself. */
  readonly self: boolean;
  /** The connected node has a route to it now. */
  readonly reachable: boolean;
}

/**
 * `client.mesh@1`: the mesh of each connected node, kept current from its
 * `mesh` stream. One feed per connection, shared by every subscriber: the
 * first subscriber opens it, the last one closes it.
 */
export interface MeshMembership {
  /**
   * What the connection's node reports: `undefined` while nobody subscribes,
   * while the connection is not open and until the first answer; empty when
   * the first answer fails (no mesh plugin there). The same array until it
   * changes.
   */
  members(connection: string): readonly MeshMember[] | undefined;
  /** Follows the connection's mesh; `listener` fires whenever `members` changes. */
  subscribe(connection: string, listener: () => void): Disposable;
}

export interface Route {
  /** The connection (node this client talks to). */
  readonly node?: string;
  /** Another node of that node's mesh, reached through it (D47). */
  readonly remote?: string;
  readonly thread?: string;
  /** Without `thread`: a new thread (a draft until its first message) in this project. */
  readonly project?: string;
  /** A view over the main area, e.g. "settings", or a panel such as "inspector". */
  readonly panel?: string;
  /** A part of the panel, e.g. a settings section. */
  readonly section?: string;
}

/** `client.navigation@1`: where the user is; kept in the URL. */
export interface Navigation {
  current(): Route;
  navigate(route: Route): void;
  subscribe(listener: () => void): Disposable;
}

/** The `jhin.ui` config section: slot rules (D12), keyed by slot name. */
export const UI_CONFIG_SECTION = "jhin.ui";
export const UiConfig = z
  .object({
    hide: z.record(z.string(), z.array(z.string())).default({}).meta({
      title: "Hidden contributions",
      description: "By slot name (e.g. sidebar.actions): the contribution ids not to render.",
    }),
    order: z.record(z.string(), z.array(z.string())).default({}).meta({
      title: "Contribution order",
      description: "By slot name: contribution ids to render first, in this order.",
    }),
  })
  .meta({
    title: "Interface",
    description: "Hides and reorders what plugins contribute to the web client's slots.",
  });
export type UiConfig = z.output<typeof UiConfig>;

/**
 * The `jhin.keybindings` config section: rules layered over the defaults of
 * client plugins. A rule for a command replaces every default of that command,
 * as in T3 Code; a rule with an empty `key` unbinds it.
 */
export const KEYBINDINGS_CONFIG_SECTION = "jhin.keybindings";
export const KeybindingRule = z.object({
  /** e.g. `mod+k`, `mod+shift+[`; `mod` is ⌘ on macOS and Ctrl elsewhere. */
  key: z
    .string()
    .max(64)
    .meta({
      title: "Key",
      description: "mod is ⌘ on macOS and Ctrl elsewhere; empty unbinds the command.",
      examples: ["mod+k"],
      // An empty key means "unbound", not "unset" (D478).
      clearWhenEmpty: "persist",
    }),
  /** A client command name. */
  command: z
    .string()
    .min(1)
    .meta({ title: "Command", examples: ["palette.open"] }),
  /** A condition over context keys: `!composerFocus && turnRunning`. */
  when: z
    .string()
    .max(256)
    .optional()
    .meta({ title: "When", examples: ["!composerFocus && turnRunning"] }),
});
export type KeybindingRule = z.output<typeof KeybindingRule>;
export const KeybindingsConfig = z
  .object({
    rules: z.array(KeybindingRule).max(256).default([]).meta({
      title: "Rules",
      description:
        'Each { "key", "command", "when" } replaces the defaults of its command; an empty key unbinds it. Settings → Keybindings records them per device.',
    }),
  })
  .meta({ title: "Keybindings", description: "Shortcuts every client of this node starts with." });
export type KeybindingsConfig = z.output<typeof KeybindingsConfig>;

/** Where projects and threads live: a connected node, or a node of its mesh. */
export interface NodeTarget {
  /** The connection. */
  readonly node: string;
  /** A node of the connection's mesh; the connection's own node when absent. */
  readonly remote?: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  /** Absolute working directory on its node. */
  readonly path: string;
  /** The built-in project for chats without a project (D51). */
  readonly scratch: boolean;
  readonly createdAt: string;
}

export type TurnStatus = "running" | "waiting" | "completed" | "interrupted" | "failed";

export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string;
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  /** The thread's own working directory (a git worktree); its project's when absent. */
  readonly worktreePath?: string;
  /** Values chosen for the model's options (D297). */
  readonly modelOptions?: readonly ModelOptionSelection[];
  readonly lastTurn?: {
    readonly turnId: string;
    readonly status: TurnStatus;
    readonly at: string;
    readonly agentId: string;
    /** What a waiting turn asks the user for. */
    readonly waitingFor?: "approval" | "user-input";
  };
  // Where the sidebar keeps the thread, kept on its node (D75–D78).
  /** Settled or kept active by hand, until the thread's next turn. */
  readonly settledOverride?: "settled" | "active";
  /** When it was settled by hand. */
  readonly settledAt?: string;
  /** When it last came back from the Settled shelf. */
  readonly unsettledAt?: string;
  readonly pinnedAt?: string;
  /** Its place among the pinned threads: a fractional key, compared as text. */
  readonly pinOrderKey?: string;
  /** Its place among the active threads, once dragged there. */
  readonly activeOrderKey?: string;
  /** Hidden until then, unless it asks for something, fails or completes. */
  readonly snoozedUntil?: string;
  readonly snoozedAt?: string;
  /** When a snooze last ended by hand. */
  readonly lastSnoozeWakeAt?: string;
  /** The thread and turn it was forked at. */
  readonly forkedFrom?: { readonly threadId: string; readonly turnId: string };
  /** A fork merged back, delivered to the agent with the next message. */
  readonly pendingMergeBack?: {
    readonly id: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly at: string;
  };
  /** Set while the thread never settles by itself (T3's per-thread "Auto-settle behavior"). */
  readonly autoSettleDisabledAt?: string;
  /** When the user last sent it a message. */
  readonly lastMessageAt?: string;
}

/**
 * Where the sidebar lists a thread (D75–D77); `working` only while the
 * device's Working section is on (D452).
 */
export type ThreadSection = "pinned" | "active" | "working" | "snoozed" | "settled";

/** What a client knows of one node's projects and threads. */
export interface NodeCatalog {
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly projects: readonly ProjectRecord[];
  /** Archived threads included; oldest first. */
  readonly threads: readonly ThreadRecord[];
}

/**
 * `client.undo@1`: T3 Code's undo notice for thread actions (provided by
 * `jhin.thread-actions`). An action run through `run` that succeeds is offered
 * for undo in the sidebar for a few seconds ("Unpinned 1 thread, ⌘Z to undo");
 * the command `thread.undo` takes back the latest group.
 */
export const UNDO_CAPABILITY = "client.undo";

export interface ThreadUndoService {
  /**
   * Runs `perform` (true when it did something) and, if it did, offers
   * `revert`. `kind` and `key` name what it claims: a later run of the same
   * kind on the same key voids the earlier one's undo. Once it succeeded, the
   * undos of `voids` (kinds on the same key) are void: settling a thread
   * takes back its unpin and its snooze.
   */
  run(options: {
    readonly kind: string;
    readonly key: string;
    /** What was done, as the notice says it: "Unpinned", "Discarded". */
    readonly action: string;
    /** What it was done to, singular, as the notice counts it: "thread", "draft". */
    readonly noun: string;
    /** The toast title when the undo fails, e.g. "Failed to undo unpin". */
    readonly failureTitle: string;
    readonly perform: () => Promise<boolean>;
    readonly revert: () => Promise<unknown>;
    readonly voids?: readonly string[];
  }): Promise<boolean>;
  /** Voids the undo of `kind` on `key`: an action undid it another way. */
  invalidate(kind: string, key: string): void;
}

/** `client.visits@1`: when the user last looked at each thread, on this device. */
export const VISITS_CAPABILITY = "client.visits";

/** The key of a thread in a `ThreadVisits` snapshot. */
export const visitKey = (target: NodeTarget, threadId: string): string =>
  `${targetKey(target)}|${threadId}`;

export interface ThreadVisits {
  /** When the thread was last seen, as a time of the thread's node. */
  get(target: NodeTarget, threadId: string): string | undefined;
  /** Records that the thread was seen as of `at` (a time of its node); never moves back. */
  visit(target: NodeTarget, threadId: string, at: string): void;
  /** The thread's latest turn shows as new again. */
  markUnread(target: NodeTarget, threadId: string): void;
  /** Every visit by `visitKey`: a new object whenever one changes, for renders to read. */
  snapshot(): Readonly<Record<string, string>>;
  subscribe(listener: () => void): Disposable;
}

/**
 * What the `thread.actions` slot gives each item of a thread's menu (the
 * sidebar's context menu, the thread view's title menu).
 */
export interface ThreadActionProps {
  readonly target: NodeTarget;
  readonly thread: ThreadRecord;
  /** The thread's project, where the menu knows it. */
  readonly project?: ProjectRecord;
  /** Starts renaming the thread in place, where the menu's host can. */
  readonly rename?: () => void;
  /** Where the menu's host lists the thread, as of the host's clock (the sidebar's). */
  readonly section?: ThreadSection;
}

/**
 * The hook `thread.settle` and `thread.snooze` run through (D75, D77): a host
 * that lists threads, such as the sidebar, moves on from the open thread when
 * it leaves the list (T3 Code's settle-and-advance). The output says whether
 * the node did it.
 */
export const THREAD_PARK_HOOK = "thread.park";
export interface ThreadParkInput {
  readonly target: NodeTarget;
  readonly threadId: string;
  readonly action: "settle" | "snooze";
}

/**
 * The hook a client's thread start runs (D253): `before` hooks add to what
 * `threads.create` gets for a draft's first message, e.g. the `workspace` a
 * thread works in. Its output is those parameters.
 */
export const THREAD_CREATE_HOOK = "thread.create";
export interface ThreadCreateInput {
  readonly target: NodeTarget;
  readonly projectId: string;
  /** The parameters of `threads.create`, as far as the hooks before have added. */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The hook deleting a thread runs through (D255), after the user confirmed it:
 * `around` hooks may ask more and act after the node deleted it (a worktree
 * only that thread used). The output says whether the thread was deleted.
 */
export const THREAD_DELETE_HOOK = "thread.delete";
export interface ThreadDeleteInput {
  readonly target: NodeTarget;
  readonly thread: ThreadRecord;
  readonly project?: ProjectRecord;
}

/** What the `project.actions` slot gives each item of a project's menu. */
export interface ProjectActionProps {
  readonly target: NodeTarget;
  readonly project: ProjectRecord;
}

/** What the `node.actions` slot gives each item of a connected node's menu. */
export interface NodeActionProps {
  readonly connection: NodeConnection;
}

/**
 * What the `node.member.actions` slot gives each item of the menu of a member
 * of a connection's mesh (settings → Nodes): the member, reached through
 * `connection` (its target is `{ node: connection.id, remote: member.nodeId }`).
 */
export interface NodeMemberActionProps {
  readonly connection: NodeConnection;
  readonly member: MeshMember;
}

/**
 * What the `chat.header.actions` slot gives each contribution: the open
 * thread (none while drafting) and where it lives.
 */
export interface ChatHeaderActionProps {
  readonly target: NodeTarget;
  readonly thread?: ThreadRecord;
  readonly project?: ProjectRecord;
}

/**
 * What the `chat.message.actions` slot gives each contribution: a message of
 * the timeline whose hover row it renders in (T3 Code's copy, "Edit from
 * here" and "Fork from this response" buttons). `assistant` is a turn's final
 * answer.
 */
export interface ChatMessageActionProps {
  readonly target: NodeTarget;
  readonly threadId: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** The message belongs to the thread's latest turn. */
  readonly latest: boolean;
  /** A turn of the thread runs now. */
  readonly running: boolean;
}

/**
 * What the `chat.drawer` slot gives each contribution: the open thread, shown
 * under its chat (T3's terminal drawer is one).
 */
export interface ChatDrawerProps {
  readonly target: NodeTarget;
  readonly thread: ThreadRecord;
  readonly project: ProjectRecord;
}

/**
 * The `sidebar.thread.details` slot gets the same props: lines of the card
 * T3 Code shows while the pointer rests on a thread (its hover card), after
 * the project and the node and before the agent, such as the thread's branch.
 */
export const THREAD_DETAILS_SLOT = "sidebar.thread.details";

/**
 * The `sidebar.notices` slot: notes at the top of the sidebar's footer, as
 * T3 Code shows its undo notice there (no props).
 */
export const SIDEBAR_NOTICES_SLOT = "sidebar.notices";

/**
 * What the `sidebar.thread.indicators` slot gives each contribution: a
 * thread card and where its thread lives. Contributions render on the card's
 * last line, between where T3 Code shows the branch and the node's and
 * agent's icons at its right end (the branch, a running terminal, the pull
 * request, the diff); one that takes the free width (`flex-1`) pushes the
 * ones after it to the right.
 */
export interface ThreadIndicatorProps {
  readonly target: NodeTarget;
  readonly thread: ThreadRecord;
  readonly project?: ProjectRecord;
  /** The card is the open thread. */
  readonly active: boolean;
}

/**
 * What the `chat.turn.footer` slot gives each contribution: one turn of the
 * open thread, rendered after the turn's answer (T3 Code puts its changed
 * files card there).
 */
export interface ChatTurnFooterProps {
  readonly target: NodeTarget;
  readonly thread: ThreadRecord;
  readonly turnId: string;
  readonly state: "running" | "completed" | "interrupted" | "failed";
  /** The thread's latest turn. */
  readonly latest: boolean;
}

/**
 * What the `chat.composer.context` slot gives each contribution: the strip
 * under the composer (T3 Code's branch toolbar) for the open thread, or the
 * project of a thread being drafted.
 */
export interface ChatComposerContextProps {
  readonly target: NodeTarget;
  readonly thread?: ThreadRecord;
  readonly project?: ProjectRecord;
}

/**
 * `client.threads@1`: the projects and threads of every node this client
 * reaches, kept current from each node's `threads` index while somebody
 * subscribes, and the way to run commands there.
 */
export interface ThreadsCatalog {
  /** The latest snapshot; the same object until it changes. */
  catalog(target: NodeTarget): NodeCatalog;
  /** Follows the target; `listener` fires whenever its catalog changes. */
  subscribe(target: NodeTarget, listener: () => void): Disposable;
  /** Runs a command on the target's node: directly, or relayed through the mesh. */
  call<T = unknown>(target: NodeTarget, method: string, params?: unknown): Promise<T>;
  /** The stream to read a thread from on the connection: the thread, or this node's copy of it (D26). */
  open(target: NodeTarget, threadId: string): Promise<string>;
}

/** What a node says it is (`host.identity`). */
export interface NodeMachine {
  /** The kind its icon shows: the owner's choice, else what the node detects, else `server`. */
  readonly kind: MachineKind;
  /** What the node tells by itself; absent when it cannot. */
  readonly detected?: MachineKind;
  readonly hostname: string;
  /** Node's `process.platform` there, e.g. `linux`, `darwin`, `win32`. */
  readonly platform: string;
}

/**
 * `client.machines@1`: what kind of machine each node runs on, for its icon.
 * A node is asked once somebody follows it, again when its connection opens
 * again and whenever the node config of a node behind that connection is
 * saved from this client.
 */
export interface NodeMachines {
  /**
   * What the node reported; `undefined` while nobody follows it, until it
   * answers, and when it cannot (a node older than `host.identity`): show
   * it as a `server`. The same object until it changes.
   */
  get(target: NodeTarget): NodeMachine | undefined;
  /** Follows the target; `listener` fires whenever `get` changes. */
  subscribe(target: NodeTarget, listener: () => void): Disposable;
}

/** A stable key for a target, e.g. for maps and storage. */
export const targetKey = (target: NodeTarget): string =>
  target.remote === undefined ? target.node : `${target.node}|${target.remote}`;

/**
 * `client.settings@1`: this device's layer of the client's config, kept in the
 * browser. Client plugins define sections with `context.config.define` and read
 * them with `context.config.get`; the device layer wins over the node's.
 */
export interface DeviceSettings {
  /** What this device set in a section, before defaults and the other layers. */
  values(section: string): Readonly<Record<string, unknown>>;
  /** Sets keys of a section on this device; a key set to `undefined` is removed. */
  patch(section: string, values: Readonly<Record<string, unknown>>): void;
  /** Forgets everything this device set in a section. */
  reset(section: string): void;
}

/** `ui.keybindings@1`: keyboard shortcuts that run client commands. */
export const KEYBINDINGS_CAPABILITY = "ui.keybindings";

export interface ActiveKeybinding {
  readonly command: string;
  readonly key: string;
  readonly when?: string;
  /** Who set it: a plugin's default, or the `jhin.keybindings` config section. */
  readonly source: "default" | "config";
}

export interface Keybindings {
  /** Adds a plugin's default shortcuts; config rules for a command replace its defaults. */
  addDefaults(rules: readonly KeybindingRule[]): Disposable;
  /**
   * Sets a context key `when` clauses can test (e.g. `composerFocus`) until
   * the returned disposable is disposed.
   */
  setContext(key: string, value: boolean): Disposable;
  /** The shortcut of a command as shown to people, e.g. "⌘K" or "Ctrl+K". */
  labelFor(command: string): string | undefined;
  /** Every shortcut in effect, later ones winning. */
  list(): readonly ActiveKeybinding[];
  /** Fires when shortcuts or labels change. */
  subscribe(listener: () => void): Disposable;
}

/** An agent runtime of a node, as `agents.list` reports it. */
export interface AgentInfo {
  readonly agentId: string;
  readonly name: string;
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    /** What a turn can choose for the model: effort, fast mode, … (D297). */
    readonly options?: readonly ModelOptionDescriptor[];
  }[];
  readonly defaultModel?: string;
  readonly runtimeModes: readonly string[];
  readonly interactionModes: readonly string[];
  readonly available: boolean;
  readonly message?: string;
  readonly version?: string;
  /** The agent a thread without a chosen agent runs. */
  readonly default: boolean;
  /** Its turns take messages while they run (a steer); absent from older nodes. */
  readonly steering?: boolean;
}

/**
 * What a control contributed for config fields gets (D482): a field whose
 * schema says `.meta({ control: "<name>" })` renders the first visible
 * contribution of the slot `settings.config.control.<name>` with these props.
 */
export interface ConfigControlProps {
  /** The field's key, and its path inside the section. */
  readonly field: {
    readonly key: string;
    readonly path: readonly string[];
    readonly title: string;
    /** The field's JSON Schema; for a nullable field, its other branch. */
    readonly schema: Readonly<Record<string, unknown>>;
    readonly hasDefault: boolean;
    readonly default?: unknown;
    readonly example?: string;
    /** `writeOnly`: never show the value in clear (D83). */
    readonly secret: boolean;
  };
  /** The value in the edited file; `undefined` while the key is unset. */
  readonly value: unknown;
  /** Sets the value; `undefined` removes the key, so it takes its default. */
  onChange(next: unknown): void;
  /** The accessible name of the control. */
  readonly label: string;
  readonly invalid: boolean;
  /** The id of the element that says what is wrong, while something is. */
  readonly describedBy?: string;
  readonly disabled: boolean;
}

/** The slot of the config field control named `name` (D482). */
export const configControlSlot = (name: string): string => `settings.config.control.${name}`;
