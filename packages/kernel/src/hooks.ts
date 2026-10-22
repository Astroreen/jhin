import {
  toDisposable,
  type AfterHook,
  type AroundHook,
  type Awaitable,
  type BeforeHook,
  type Disposable,
} from "@jhin/sdk";

type Kind = "before" | "around" | "after";

interface Entry {
  readonly kind: Kind;
  readonly plugin: string;
  readonly order: number;
  readonly sequence: number;
  // Hooks are stored type-erased; `run` restores the types its caller declares.
  readonly hook: (...args: never[]) => unknown;
}

export interface HookInfo {
  readonly name: string;
  readonly before: number;
  readonly around: number;
  readonly after: number;
}

/**
 * Named pipelines. `before` hooks transform the input, `around` hooks wrap the
 * implementation (lowest order outermost), `after` hooks transform the output.
 * Within a kind, lower order runs first; ties run in registration order.
 */
export class HookRegistry {
  readonly #entries = new Map<string, Entry[]>();
  #sequence = 0;

  add(name: string, kind: Kind, plugin: string, hook: Entry["hook"], order = 0): Disposable {
    const entry: Entry = { kind, plugin, order, sequence: this.#sequence++, hook };
    const list = [...(this.#entries.get(name) ?? []), entry].toSorted(
      (a, b) => a.order - b.order || a.sequence - b.sequence,
    );
    this.#entries.set(name, list);
    return toDisposable(() => {
      const rest = (this.#entries.get(name) ?? []).filter((item) => item !== entry);
      if (rest.length === 0) this.#entries.delete(name);
      else this.#entries.set(name, rest);
    });
  }

  async run<I, O>(name: string, input: I, implementation: (input: I) => Awaitable<O>): Promise<O> {
    const entries = this.#entries.get(name) ?? [];
    const of = (kind: Kind) => entries.filter((entry) => entry.kind === kind);

    let current = input;
    for (const entry of of("before"))
      current = await (entry.hook as unknown as BeforeHook<I>)(current);

    let call = async (value: I): Promise<O> => implementation(value);
    for (const entry of of("around").toReversed()) {
      const next = call;
      const hook = entry.hook as unknown as AroundHook<I, O>;
      call = (value: I) => hook(value, next);
    }
    let output = await call(current);

    for (const entry of of("after"))
      output = await (entry.hook as unknown as AfterHook<I, O>)(output, current);
    return output;
  }

  list(): HookInfo[] {
    return [...this.#entries.entries()]
      .map(([name, entries]) => ({
        name,
        before: entries.filter((entry) => entry.kind === "before").length,
        around: entries.filter((entry) => entry.kind === "around").length,
        after: entries.filter((entry) => entry.kind === "after").length,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
