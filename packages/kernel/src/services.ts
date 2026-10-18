import { toDisposable, type Disposable } from "@jhin/sdk";

import { KernelError } from "./errors.ts";

interface Entry {
  readonly plugin: string;
  readonly implementation: unknown;
}

/** Capability id → the live implementation registered by its provider. */
export class ServiceRegistry {
  readonly #entries = new Map<string, Entry>();

  provide(plugin: string, capability: string, implementation: unknown): Disposable {
    const existing = this.#entries.get(capability);
    if (existing !== undefined) {
      throw new KernelError(
        "SERVICE_ALREADY_PROVIDED",
        `Capability ${capability} is already provided`,
        {
          capability,
          plugin: existing.plugin,
        },
      );
    }
    const entry: Entry = { plugin, implementation };
    this.#entries.set(capability, entry);
    return toDisposable(() => {
      if (this.#entries.get(capability) === entry) this.#entries.delete(capability);
    });
  }

  lookup(capability: string): unknown {
    return this.#entries.get(capability)?.implementation;
  }

  has(capability: string): boolean {
    return this.#entries.has(capability);
  }

  list(): { capability: string; plugin: string }[] {
    return [...this.#entries.entries()]
      .map(([capability, entry]) => ({ capability, plugin: entry.plugin }))
      .toSorted((a, b) => a.capability.localeCompare(b.capability));
  }
}
