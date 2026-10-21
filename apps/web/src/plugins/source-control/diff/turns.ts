// The turn scopes follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/DiffPanel.tsx
// ("Latest turn" and the "Turn" submenu with each turn's time).
import { targetKey, type NodeTarget } from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";
import type {
  Diff,
  DiffScopeContext,
  DiffScopeOption,
  DiffScopeProvider,
  TurnCheckpoint,
} from "@jhin/source-control-api";

import { formatShortTimestamp } from "../../../lib/format.ts";
import type { SourceControlServices } from "../services.ts";

const TURN_SCOPE_PROVIDER = "jhin.source-control.turns";
/** The latest turn's option: it follows the thread as turns end. */
export const LATEST_TURN = "latest";
export const turnValue = (turn: number) => `turn:${turn}`;

const NO_OPTIONS: readonly DiffScopeOption[] = [];

/**
 * W3's per-turn diffs (D243–D249) as diff scopes (D283): "Latest turn", and
 * each turn whose checkpoint can be diffed in T3's "Turn" submenu, newest
 * first, read from `git.checkpoints` whenever the thread's latest checkpoint
 * changes on its node.
 */
export function turnScopeProvider(
  services: Pick<SourceControlServices, "store" | "threads" | "timestampFormat">,
): DiffScopeProvider {
  const { store, threads } = services;
  const lists = new Map<
    string,
    {
      version: string;
      turns?: readonly TurnCheckpoint[];
      options: readonly DiffScopeOption[];
      /** Settles once `turns` are read. */
      ready: Promise<void>;
    }
  >();
  const listeners = new Map<string, Set<() => void>>();
  const keyOf = (context: DiffScopeContext) => `${targetKey(context.target)}|${context.threadId}`;
  const versionOf = (context: DiffScopeContext) => {
    const latest = store.view(context.target).checkpoints.get(context.threadId!);
    return latest === undefined ? "none" : `${latest.turn}:${latest.status}:${latest.capturedAt}`;
  };
  const changed = (key: string) => {
    for (const listener of Array.from(listeners.get(key) ?? [])) listener();
  };
  const optionsOf = (turns: readonly TurnCheckpoint[]): readonly DiffScopeOption[] => [
    { value: LATEST_TURN, label: "Latest turn" },
    ...turns.map((checkpoint) => ({
      value: turnValue(checkpoint.turn),
      label: `Turn ${checkpoint.turn}`,
      group: "Turn",
      detail: formatShortTimestamp(checkpoint.capturedAt, services.timestampFormat()),
    })),
  ];
  /** Reads the thread's checkpoints when its latest one changed. */
  const refresh = (context: DiffScopeContext) => {
    const key = keyOf(context);
    const version = versionOf(context);
    const entry = lists.get(key);
    if (entry?.version === version) return entry;
    if (version === "none") {
      const none = { version, turns: [], options: optionsOf([]), ready: Promise.resolve() };
      lists.set(key, none);
      return none;
    }
    const next = {
      version,
      options: entry?.options ?? optionsOf([]),
      ready: Promise.resolve(),
    };
    next.ready = threads
      .call<{ checkpoints: TurnCheckpoint[] }>(context.target as NodeTarget, "git.checkpoints", {
        threadId: context.threadId,
      })
      .then((answer) => answer.checkpoints)
      .catch(() => [] as TurnCheckpoint[])
      .then((all) => {
        if (lists.get(key)?.version !== version) return;
        // Newest first, as T3 lists them; only turns whose checkpoint can be diffed.
        const turns = all
          .filter((checkpoint) => checkpoint.status === "ready")
          .toSorted((a, b) => b.turn - a.turn);
        lists.set(key, { version, turns, options: optionsOf(turns), ready: next.ready });
        changed(key);
      });
    lists.set(key, next);
    return next;
  };
  return {
    id: TURN_SCOPE_PROVIDER,
    order: 10,
    options: (context) => (context.threadId === undefined ? NO_OPTIONS : refresh(context).options),
    subscribe(context, listener): Disposable {
      if (context.threadId === undefined) return toDisposable(() => undefined);
      const key = keyOf(context);
      const set = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, set);
      set.add(listener);
      // A turn that ends moves the thread's latest checkpoint on the source control stream.
      const status = store.subscribe(context.target as NodeTarget, () => {
        if (lists.get(key)?.version !== versionOf(context)) {
          refresh(context);
          listener();
        }
      });
      return toDisposable(() => {
        set.delete(listener);
        status.dispose();
      });
    },
    async load(context, value, input) {
      if (context.threadId !== undefined) await refresh(context).ready;
      const turns = lists.get(keyOf(context))?.turns ?? [];
      const turn =
        value === LATEST_TURN
          ? turns[0]?.turn
          : turns.find((checkpoint) => turnValue(checkpoint.turn) === value)?.turn;
      if (context.threadId === undefined || turn === undefined) {
        throw new Error("No completed turns yet.");
      }
      const diff = await threads.call<Diff>(context.target as NodeTarget, "git.diff", {
        threadId: context.threadId,
        scope: "turn",
        turn,
        ignoreWhitespace: input.ignoreWhitespace,
      });
      return {
        patch: diff.patch,
        truncated: diff.truncated,
        insertions: diff.insertions,
        deletions: diff.deletions,
        baseRef: null,
        headRef: null,
      };
    },
  };
}
