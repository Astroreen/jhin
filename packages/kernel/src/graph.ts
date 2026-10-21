import type { PluginManifest } from "@jhin/sdk";
// The one function, not the whole package: it is in the web client's entry chunk (D440).
import satisfies from "semver/functions/satisfies.js";

import type { ErrorInfo } from "./errors.ts";

export interface Resolution {
  /** Plugins that can activate, dependencies first. */
  readonly order: readonly string[];
  /** Plugins that cannot activate, with the reason. */
  readonly blocked: ReadonlyMap<string, ErrorInfo>;
  /** Capability → the plugin providing it. */
  readonly providers: ReadonlyMap<string, string>;
  /** Plugin → the plugins whose capabilities it uses (required, or optional and present). */
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  /** Plugin → the plugins it cannot run without. */
  readonly requiredDependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Validates the capability graph and computes an activation order.
 * Never throws: every problem blocks the plugins it affects and nothing else.
 */
export function resolveGraph(manifests: readonly PluginManifest[]): Resolution {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const blocked = new Map<string, ErrorInfo>();
  const block = (id: string, info: ErrorInfo) => {
    if (!blocked.has(id)) blocked.set(id, info);
  };

  // 1. One provider per capability.
  const candidates = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const capability of Object.keys(manifest.provides)) {
      candidates.set(capability, [...(candidates.get(capability) ?? []), manifest.id]);
    }
  }
  const providers = new Map<string, string>();
  for (const [capability, ids] of candidates) {
    if (ids.length === 1) {
      providers.set(capability, ids[0]!);
      continue;
    }
    for (const id of ids) {
      block(id, {
        code: "CAPABILITY_CONFLICT",
        message: `Capability ${capability} is provided by several plugins: ${ids.join(", ")}`,
        details: { capability, providers: ids },
      });
    }
  }

  // 2. Edges, missing capabilities and version mismatches.
  const dependencies = new Map<string, Set<string>>();
  const requiredDependencies = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const all = new Set<string>();
    const required = new Set<string>();
    for (const [capability, range] of Object.entries(manifest.requires)) {
      const provider = providers.get(capability);
      const version = provider === undefined ? undefined : byId.get(provider)!.provides[capability];
      if (provider === undefined || version === undefined) {
        block(manifest.id, {
          code: "CAPABILITY_MISSING",
          message: `Required capability ${capability}@${range} is not provided by any plugin`,
          details: { capability, range },
        });
        continue;
      }
      if (!satisfies(version, range)) {
        block(manifest.id, {
          code: "VERSION_MISMATCH",
          message: `Required capability ${capability}@${range} is provided by ${provider} at ${version}`,
          details: { capability, range, provider, version },
        });
        continue;
      }
      if (provider !== manifest.id) {
        all.add(provider);
        required.add(provider);
      }
    }
    for (const [capability, range] of Object.entries(manifest.optional)) {
      const provider = providers.get(capability);
      const version = provider === undefined ? undefined : byId.get(provider)!.provides[capability];
      if (
        provider !== undefined &&
        version !== undefined &&
        provider !== manifest.id &&
        satisfies(version, range)
      ) {
        all.add(provider);
      }
    }
    dependencies.set(manifest.id, all);
    requiredDependencies.set(manifest.id, required);
  }

  // 3. Cycles. Only required edges can deadlock; an optional edge that closes a
  //    cycle is dropped (the plugin then runs without that optional capability).
  const ids = manifests.map((manifest) => manifest.id);
  for (const cycle of findCycles(ids, requiredDependencies)) {
    for (const id of cycle) {
      block(id, {
        code: "DEPENDENCY_CYCLE",
        message: `Dependency cycle: ${[...cycle, cycle[0]].join(" → ")}`,
        details: { cycle },
      });
    }
  }
  for (const component of findCycles(ids, dependencies)) {
    const members = new Set(component);
    for (const id of component) {
      const edges = dependencies.get(id)!;
      const required = requiredDependencies.get(id)!;
      for (const dependency of edges) {
        if (members.has(dependency) && !required.has(dependency)) edges.delete(dependency);
      }
    }
  }

  // 4. A blocked required dependency blocks its dependants; a blocked optional one is dropped.
  let changed = true;
  while (changed) {
    changed = false;
    for (const manifest of manifests) {
      if (blocked.has(manifest.id)) continue;
      const failed = [...requiredDependencies.get(manifest.id)!].find((dependency) =>
        blocked.has(dependency),
      );
      if (failed !== undefined) {
        block(manifest.id, {
          code: "DEPENDENCY_UNAVAILABLE",
          message: `Required dependency ${failed} cannot activate`,
          details: { dependency: failed },
        });
        changed = true;
      }
    }
  }
  for (const [id, edges] of dependencies) {
    for (const dependency of edges) if (blocked.has(dependency)) edges.delete(dependency);
    if (blocked.has(id)) edges.clear();
  }

  // 5. Deterministic topological order.
  const remaining = manifests.map((manifest) => manifest.id).filter((id) => !blocked.has(id));
  const indegree = new Map(remaining.map((id) => [id, dependencies.get(id)!.size]));
  const ready = remaining.filter((id) => indegree.get(id) === 0).toSorted();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const other of remaining) {
      if (dependencies.get(other)!.has(id)) {
        const left = indegree.get(other)! - 1;
        indegree.set(other, left);
        if (left === 0) {
          ready.push(other);
          ready.sort();
        }
      }
    }
  }

  return { order, blocked, providers, dependencies, requiredDependencies };
}

/** Strongly connected components with more than one member (Tarjan). */
function findCycles(
  ids: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string) => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of edges.get(id) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, index.get(next)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      if (component.length > 1) cycles.push(component.toReversed());
    }
  };

  for (const id of ids) if (!index.has(id)) visit(id);
  return cycles;
}
