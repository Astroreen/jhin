import { toDisposable, type Disposable } from "@jhin/sdk";
import * as React from "react";

export const UI_SLOTS_CAPABILITY = "ui.slots";

/** Something a plugin puts into a slot; `id` is public API (D12). */
export interface Contribution<P = Record<string, never>> {
  readonly id: string;
  /** Lower comes first; ties sort by id. Default 0. */
  readonly order?: number;
  readonly component: React.ComponentType<P>;
}

/**
 * Overrides from config, per slot: hide contributions, or put some first in a
 * given order. Keys are slot names, values contribution ids.
 */
export interface SlotRules {
  readonly hide?: Readonly<Record<string, readonly string[]>>;
  readonly order?: Readonly<Record<string, readonly string[]>>;
}

/** `ui.slots@1`: named places in the UI that plugins contribute to. */
export interface SlotRegistry {
  contribute<P>(slot: string, contribution: Contribution<P>): Disposable;
  /** Called when a contribution throws while rendering. */
  reportError(id: string, error: unknown): void;
  /** Render key of a contribution; new on every registration, so a reloaded plugin gets a fresh error boundary. */
  keyOf(contribution: Contribution<never>): string;
  /** Visible contributions of a slot, in display order. */
  list(slot: string): readonly Contribution<never>[];
  setRules(rules: SlotRules): void;
  subscribe(listener: () => void): Disposable;
}

interface Entry {
  readonly contribution: Contribution<never>;
  /** New on every registration, so a plugin reload starts with a fresh error boundary. */
  readonly key: string;
}

export function createSlotRegistry(
  options: { onError?: (id: string, error: unknown) => void } = {},
): SlotRegistry {
  const slots = new Map<string, Entry[]>();
  let registrations = 0;
  const listeners = new Set<() => void>();
  let rules: SlotRules = {};
  // Lists are cached per version so React sees stable snapshots.
  let version = 0;
  const cache = new Map<string, { version: number; list: readonly Contribution<never>[] }>();
  const keys = new WeakMap<Contribution<never>, string>();
  const changed = () => {
    version += 1;
    for (const listener of Array.from(listeners)) listener();
  };

  return {
    contribute(slot, contribution) {
      const list = slots.get(slot) ?? [];
      if (list.some((item) => item.contribution.id === contribution.id)) {
        throw new Error(`Slot ${slot} already has a contribution ${contribution.id}`);
      }
      registrations += 1;
      const entry: Entry = {
        contribution: contribution as unknown as Contribution<never>,
        key: `${contribution.id}#${registrations}`,
      };
      keys.set(entry.contribution, entry.key);
      slots.set(slot, [...list, entry]);
      changed();
      return toDisposable(() => {
        slots.set(
          slot,
          (slots.get(slot) ?? []).filter((item) => item !== entry),
        );
        changed();
      });
    },
    reportError(id, error) {
      options.onError?.(id, error);
    },
    list(slot) {
      const cached = cache.get(slot);
      if (cached?.version === version) return cached.list;
      const hidden = new Set(rules.hide?.[slot] ?? []);
      const first = rules.order?.[slot] ?? [];
      const rank = (id: string) => (first.includes(id) ? first.indexOf(id) : first.length);
      const list = (slots.get(slot) ?? [])
        .map((item) => item.contribution)
        .filter((item) => !hidden.has(item.id))
        .toSorted(
          (a, b) =>
            rank(a.id) - rank(b.id) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
        );
      cache.set(slot, { version, list });
      return list;
    },
    setRules(next) {
      rules = next;
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    keyOf: (contribution) => keys.get(contribution) ?? contribution.id,
  };
}

const SlotsContext = React.createContext<SlotRegistry | undefined>(undefined);

export function SlotsProvider(props: {
  registry: SlotRegistry;
  children: React.ReactNode;
}): React.ReactNode {
  return <SlotsContext.Provider value={props.registry}>{props.children}</SlotsContext.Provider>;
}

export function useSlot(slot: string): readonly Contribution<never>[] {
  const registry = React.useContext(SlotsContext);
  if (registry === undefined) throw new Error("useSlot needs a SlotsProvider");
  return React.useSyncExternalStore(
    (listener) => {
      const subscription = registry.subscribe(listener);
      return () => subscription.dispose();
    },
    () => registry.list(slot),
  );
}

/** `useSlot` that lists nothing outside a `SlotsProvider` (a form rendered on its own). */
export function useOptionalSlot(slot: string): readonly Contribution<never>[] {
  const registry = React.useContext(SlotsContext);
  return React.useSyncExternalStore(
    (listener) => {
      const subscription = registry?.subscribe(listener);
      return () => subscription?.dispose();
    },
    () => registry?.list(slot) ?? NONE,
  );
}
const NONE: readonly Contribution<never>[] = [];

/** A plugin's broken component shows a note instead of taking the page down. */
class ContributionBoundary extends React.Component<
  { id: string; onError: (id: string, error: unknown) => void; children: React.ReactNode },
  { error: unknown }
> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(this.props.id, error);
  }

  override render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return (
        <div
          role="alert"
          data-contribution-error={this.props.id}
          className="text-error-foreground text-xs"
        >
          {this.props.id} failed to render
        </div>
      );
    }
    return this.props.children;
  }
}

/** Renders every visible contribution of `name` (only the first with `first`), each with `props`. */
export function Slot<P extends object>(props: {
  name: string;
  props?: P;
  first?: boolean;
}): React.ReactNode {
  const registry = React.useContext(SlotsContext);
  const all = useSlot(props.name);
  const contributions = props.first === true ? all.slice(0, 1) : all;
  return (
    <>
      {contributions.map((contribution) => {
        const Component = contribution.component as unknown as React.ComponentType<P>;
        return (
          <ContributionBoundary
            key={registry!.keyOf(contribution)}
            id={contribution.id}
            onError={(id, error) => registry!.reportError(id, error)}
          >
            <Component {...((props.props ?? {}) as P)} />
          </ContributionBoundary>
        );
      })}
    </>
  );
}
