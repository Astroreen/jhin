import type {
  AssistantCitation,
  MessageContextRecord,
  ModelOptionSelection,
} from "@jhin/agent-api";
import type {
  AgentInfo,
  Connections,
  DeviceSettings,
  Keybindings,
  MeshMembership,
  Navigation,
  NodeTarget,
  ThreadsCatalog,
} from "@jhin/client-api";
import { targetKey, type ThreadVisits } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import type { Dialogs, SlotRegistry, Toasts } from "@jhin/ui";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

import type { ComposerDraft, Drafts } from "../../lib/composer.ts";
import type { ModelOptionsMemory } from "../../lib/model-options.ts";
import type { AttachmentUrls } from "../../lib/uploads.ts";
import type { DetailsVisibility } from "./thread-details.tsx";
import type { Unconfirmed } from "./unconfirmed.ts";

/** Agents of each node, from `agents.list`, refreshed when a picker opens or after a while. */
export function createAgentsCache(threads: ThreadsCatalog) {
  const entries = new Map<
    string,
    { agents: readonly AgentInfo[] | undefined; at: number; loading: boolean }
  >();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const refresh = (target: NodeTarget) => {
    const key = targetKey(target);
    const entry = entries.get(key) ?? { agents: undefined, at: 0, loading: false };
    if (entry.loading) return;
    entries.set(key, { ...entry, loading: true });
    void threads
      .call<AgentInfo[]>(target, "agents.list")
      .then(
        (agents) => entries.set(key, { agents, at: Date.now(), loading: false }),
        () => entries.set(key, { agents: entry.agents ?? [], at: Date.now(), loading: false }),
      )
      .then(changed);
  };
  return {
    get: (target: NodeTarget) => entries.get(targetKey(target))?.agents,
    refresh,
    /** Loads once, and again when older than 30 s. */
    ensure(target: NodeTarget) {
      const entry = entries.get(targetKey(target));
      if (entry === undefined || (!entry.loading && Date.now() - entry.at > 30_000))
        refresh(target);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type AgentsCache = ReturnType<typeof createAgentsCache>;

/** What a new thread runs with: the agent, model and modes last chosen on each node. */
export interface ComposerSelection {
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  /** Values chosen for the model's options (D297). */
  readonly modelOptions?: readonly ModelOptionSelection[];
}

const SELECTION_STORAGE_KEY = "jhin.composer.selection.v1";

/** The last selection per node, kept on this device (T3 Code's sticky model selection). */
export function createLastSelection(storage: Storage = localStorage) {
  let selections: Record<string, ComposerSelection> = {};
  try {
    const value: unknown = JSON.parse(storage.getItem(SELECTION_STORAGE_KEY) ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      selections = value as Record<string, ComposerSelection>;
    }
  } catch {
    selections = {};
  }
  const listeners = new Set<() => void>();
  const empty: ComposerSelection = {};
  return {
    get: (target: NodeTarget): ComposerSelection => selections[targetKey(target)] ?? empty,
    set(target: NodeTarget, selection: ComposerSelection) {
      selections = { ...selections, [targetKey(target)]: selection };
      try {
        storage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selections));
      } catch {
        // Not kept beyond this page.
      }
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What the chat's components share; provided once at the top of the chat view. */
export interface ChatServices {
  readonly context: PluginContext;
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly mesh: MeshMembership;
  readonly threads: ThreadsCatalog;
  readonly slots: SlotRegistry;
  readonly settings: DeviceSettings;
  readonly toasts: Toasts | undefined;
  readonly dialogs: Dialogs | undefined;
  readonly keybindings: Keybindings | undefined;
  readonly drafts: Drafts;
  readonly agents: AgentsCache;
  readonly lastSelection: ReturnType<typeof createLastSelection>;
  /** The options last chosen for each model on this device. */
  readonly modelOptions: ModelOptionsMemory;
  /** Attachments read back from their nodes, for the timeline. */
  readonly attachmentUrls: AttachmentUrls;
  /** When threads were seen on this device; absent without a `client.visits` provider. */
  readonly visits: ThreadVisits | undefined;
  /** First messages that may not have reached their new thread. */
  readonly unconfirmed: Unconfirmed;
  /** What commands can do to the composer on screen. */
  readonly composer: ComposerHandle;
  /** The open thread's find bar (D801), for `chat.find`. */
  readonly threadFind: { current: { open(): void } | undefined };
  /** Whether each thread's details show, inline or in the header's popover (D1350). */
  readonly threadDetails: DetailsVisibility;
}

/**
 * What putting a context record into the composer came to: `not-now` while it takes no chips
 * (a prefilled answer, an approval), `full` at T3's 200 records.
 */
export type ContextInsertion = "inserted" | "not-now" | "full";

/** The mounted composer, for commands (focus it, open its model picker). */
export interface ComposerHandle {
  current:
    | {
        /** Where it keeps its draft: the thread (or new thread) it belongs to. */
        readonly draftKey: string;
        /** Puts a sent message back after what is typed ("Edit from here"). */
        restore(draft: ComposerDraft): void;
        /** What it holds now, before its draft is stored. */
        draft(): ComposerDraft | undefined;
        focus(): void;
        insert(text: string): void;
        /** Puts a context record's reference at the cursor (D1009), or says why it cannot. */
        insertContext(record: MessageContextRecord): ContextInsertion;
        /** Takes a record's chips and the record out of the prompt (D1286). */
        removeContext(contextId: string): boolean;
        /** Puts a quote of an agent's message at the cursor (D1012), or says why it cannot. */
        insertCitation(citation: AssistantCitation): ContextInsertion;
        toggleModelPicker(): void;
        cycleRuntimeMode(): void;
        togglePlanMode(): void;
        /** Sends the composer's message the other way while a turn runs (queue or steer). */
        sendAlternate(): Promise<boolean>;
        /** Steers the first queued message into the running turn; false when there is none. */
        steerNext(): boolean;
        /** Loads the last queued message into the composer to edit it; false when it cannot. */
        editLatest(): boolean;
        /** Resumes a stopped turn or a held queue (D800); false when there is none. */
        resume(): boolean;
      }
    | undefined;
}

export const ChatContext = createContext<ChatServices | undefined>(undefined);

export function useChat(): ChatServices {
  const services = useContext(ChatContext);
  if (services === undefined) throw new Error("useChat needs the chat's ChatContext");
  return services;
}

/** The agents of a node; loads them on first use. */
export function useAgents(target: NodeTarget): readonly AgentInfo[] | undefined {
  const { agents } = useChat();
  const list = useSyncExternalStore(agents.subscribe, () => agents.get(target));
  useEffect(() => agents.ensure(target), [agents, target.node, target.remote]);
  return list;
}
