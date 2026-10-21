// The selection store follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/diffPanelStore.ts.
import { targetKey, type ThreadsCatalog } from "@jhin/client-api";
import { toDisposable, z, type Disposable } from "@jhin/sdk";
import type {
  Diff,
  DiffScopeContext,
  DiffScopeOption,
  DiffScopeProvider,
  DiffScopes,
} from "@jhin/source-control-api";
import { useSyncExternalStore } from "react";

/** `source-control.diff-scopes@1` (D283): the providers of the diff panel's scope menu. */
export function createDiffScopes(): DiffScopes {
  let providers: readonly DiffScopeProvider[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    register(provider) {
      if (providers.some((existing) => existing.id === provider.id)) {
        throw new Error(`A diff scope provider ${provider.id} is already registered`);
      }
      providers = [...providers, provider].toSorted(
        (left, right) => (left.order ?? 0) - (right.order ?? 0),
      );
      changed();
      return toDisposable(() => {
        if (!providers.includes(provider)) return;
        providers = providers.filter((existing) => existing !== provider);
        changed();
      });
    },
    providers: () => providers,
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

const GIT_SCOPE_PROVIDER = "jhin.source-control.git";
const GIT_OPTIONS: readonly DiffScopeOption[] = [
  { value: "branch", label: "Changes", baseRefs: true },
  { value: "uncommitted", label: "Uncommitted" },
];

/** T3's "Changes" (against the default branch, or the chosen base) and "Uncommitted", from `git.diff`. */
export function gitScopeProvider(threads: ThreadsCatalog): DiffScopeProvider {
  return {
    id: GIT_SCOPE_PROVIDER,
    order: 0,
    options: () => GIT_OPTIONS,
    load: async (context, value, input) => {
      const diff = await threads.call<Diff>(context.target, "git.diff", {
        projectId: context.projectId,
        scope: value === "uncommitted" ? "uncommitted" : "branch",
        ignoreWhitespace: input.ignoreWhitespace,
        ...(input.base === undefined ? {} : { base: input.base }),
      });
      return {
        patch: diff.patch,
        truncated: diff.truncated,
        insertions: diff.insertions,
        deletions: diff.deletions,
        baseRef: diff.baseRef,
        headRef: diff.headRef,
      };
    },
  };
}

/** One option of the menu with the provider that offers it. */
export interface ScopeEntry {
  readonly provider: DiffScopeProvider;
  readonly option: DiffScopeOption;
}

const EMPTY: readonly ScopeEntry[] = [];

/**
 * Every provider's options for a context, kept current. The snapshot is the
 * same array while no provider's options change.
 */
export function useScopeEntries(
  scopes: DiffScopes,
  context: DiffScopeContext,
  contextKey: string,
): readonly ScopeEntry[] {
  return useSyncExternalStore(entriesSubscriber(scopes, context, contextKey), () =>
    entriesOf(scopes, context, contextKey),
  );
}

/**
 * Options compared by what they say, not by identity: a provider may build a
 * fresh array on every call, and the snapshot must stay the same while they
 * say the same.
 */
function sameOptions(left: readonly DiffScopeOption[], right: readonly DiffScopeOption[]) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((option, index) => {
        const other = right[index]!;
        return (
          option.value === other.value &&
          option.label === other.label &&
          option.group === other.group &&
          option.detail === other.detail &&
          option.baseRefs === other.baseRefs
        );
      }))
  );
}

/** The caches below keep the threads looked at most recently. */
const MAX_CONTEXTS = 50;
function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CONTEXTS) map.delete(map.keys().next().value!);
}

const snapshots = new WeakMap<
  DiffScopes,
  Map<string, { inputs: readonly unknown[]; entries: readonly ScopeEntry[] }>
>();
function entriesOf(
  scopes: DiffScopes,
  context: DiffScopeContext,
  contextKey: string,
): readonly ScopeEntry[] {
  const providers = scopes.providers();
  const inputs = [providers, ...providers.map((provider) => provider.options(context))];
  let byContext = snapshots.get(scopes);
  if (byContext === undefined) {
    byContext = new Map();
    snapshots.set(scopes, byContext);
  }
  const cached = byContext.get(contextKey);
  if (
    cached !== undefined &&
    cached.inputs.length === inputs.length &&
    cached.inputs[0] === inputs[0] &&
    cached.inputs.every(
      (input, index) =>
        index === 0 ||
        sameOptions(
          input as readonly DiffScopeOption[],
          inputs[index] as readonly DiffScopeOption[],
        ),
    )
  ) {
    return cached.entries;
  }
  const entries = providers.flatMap((provider, index) =>
    (inputs[index + 1] as readonly DiffScopeOption[]).map((option) => ({ provider, option })),
  );
  const value = entries.length === 0 ? EMPTY : entries;
  remember(byContext, contextKey, { inputs, entries: value });
  return value;
}

type Subscribe = (listener: () => void) => () => void;
const subscribers = new WeakMap<DiffScopes, Map<string, Subscribe>>();
/** Follows the registry and every provider's own changes for the context. */
function entriesSubscriber(
  scopes: DiffScopes,
  context: DiffScopeContext,
  contextKey: string,
): Subscribe {
  let byContext = subscribers.get(scopes);
  if (byContext === undefined) {
    byContext = new Map();
    subscribers.set(scopes, byContext);
  }
  let subscribe = byContext.get(contextKey);
  if (subscribe === undefined) {
    const fixed = { ...context };
    subscribe = (listener) => {
      let followed = new Map<DiffScopeProvider, Disposable | undefined>();
      const follow = () => {
        const next = new Map<DiffScopeProvider, Disposable | undefined>();
        for (const provider of scopes.providers()) {
          next.set(
            provider,
            followed.has(provider) ? followed.get(provider) : provider.subscribe?.(fixed, listener),
          );
        }
        for (const [provider, subscription] of followed) {
          if (!next.has(provider)) subscription?.dispose();
        }
        followed = next;
      };
      follow();
      const registry = scopes.subscribe(() => {
        follow();
        listener();
      });
      return () => {
        registry.dispose();
        for (const subscription of followed.values()) subscription?.dispose();
        followed = new Map();
      };
    };
    remember(byContext, contextKey, subscribe);
  }
  return subscribe;
}

/** What the panel shows for a thread (or draft): the chosen scope and the base of "Changes". */
export interface DiffSelection {
  /** An option's value; none is the first option ("Changes"). */
  readonly value?: string;
  /** The base chosen in the picker; none is automatic (the default branch). */
  readonly base?: string;
}

const SELECTION_STORAGE_KEY = "jhin.diff-panel.v1";

/** What is stored; anything else in storage is dropped. */
const StoredSelection = z.object({
  value: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
});
/** The most recently changed selections kept; older threads fall back to the defaults. */
const MAX_SELECTIONS = 200;

/** The panel's selection per thread or draft, kept on this device (T3's diffPanelStore). */
export function createDiffSelections(storage: Storage = localStorage) {
  let selections: Record<string, DiffSelection> = {};
  try {
    const value: unknown = JSON.parse(storage.getItem(SELECTION_STORAGE_KEY) ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const parsed = StoredSelection.safeParse(entry);
        if (parsed.success) selections[key] = parsed.data as DiffSelection;
      }
    }
  } catch {
    selections = {};
  }
  const listeners = new Set<() => void>();
  const empty: DiffSelection = {};
  return {
    get: (key: string): DiffSelection => selections[key] ?? empty,
    update(key: string, change: { [K in keyof DiffSelection]?: DiffSelection[K] | undefined }) {
      const next: Record<string, unknown> = { ...selections[key], ...change };
      for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field];
      // Insertion order is recency: the key moves last, the oldest go past the limit.
      const { [key]: _previous, ...rest } = selections;
      const kept = Object.entries(rest).slice(-(MAX_SELECTIONS - 1));
      selections = { ...Object.fromEntries(kept), [key]: next as DiffSelection };
      try {
        storage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selections));
      } catch {
        // Full or blocked storage: the selection lasts for this page only.
      }
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void): Disposable {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

export type DiffSelections = ReturnType<typeof createDiffSelections>;

/** The selection's key: the thread, or the project a thread is drafted in. */
export function selectionKey(context: DiffScopeContext): string {
  const where = targetKey(context.target);
  return context.threadId === undefined
    ? `${where}|draft|${context.projectId}`
    : `${where}|${context.threadId}`;
}
