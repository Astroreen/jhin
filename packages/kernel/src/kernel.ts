import {
  DisposableStore,
  PluginManifest,
  type CommandInfo,
  type Disposable,
  type Invocation,
  type Logger,
  type PluginContext,
  type PluginDefinition,
} from "@jhin/sdk";

import { CommandRegistry } from "./commands.ts";
import { ConfigRegistry, DEFAULT_CONFIG_LAYERS } from "./config.ts";
import { KernelError, toErrorInfo, type ErrorInfo } from "./errors.ts";
import { EventBus, type KernelEvent } from "./events.ts";
import { resolveGraph, type Resolution } from "./graph.ts";
import { HookRegistry, type HookInfo } from "./hooks.ts";
import { noopLogger } from "./logger.ts";
import { ServiceRegistry } from "./services.ts";

export type KernelSide = "server" | "client";

/** A plugin as found by a host: where it lives and its raw `"jhin"` manifest. */
export interface PluginSource {
  readonly location: string;
  readonly manifest: unknown;
}

/** Host-provided module loading; the kernel never touches a filesystem or a URL itself. */
export interface ModuleLoader {
  /** `generation` increases on every reload so hosts can bust module caches. */
  load(source: PluginSource, manifest: PluginManifest, generation: number): Promise<unknown>;
}

export interface KernelOptions {
  readonly side: KernelSide;
  readonly loader: ModuleLoader;
  readonly logger?: Logger;
  /** Config layer names, lowest precedence first. */
  readonly configLayers?: readonly string[];
}

/**
 * - `active`: running.
 * - `failed`: its own activation threw or its module is invalid.
 * - `blocked`: cannot run because of the graph or an unavailable required dependency.
 * - `inactive`: stopped or waiting to activate.
 * - `skipped`: built for the other side.
 */
export type PluginStatus = "active" | "failed" | "blocked" | "inactive" | "skipped";

export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  readonly side: string;
  readonly location: string;
  readonly status: PluginStatus;
  readonly error?: ErrorInfo;
  readonly provides: Readonly<Record<string, string>>;
  readonly requires: Readonly<Record<string, string>>;
  readonly optional: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}

export interface KernelSnapshot {
  readonly side: KernelSide;
  readonly plugins: readonly PluginInfo[];
  readonly invalid: readonly { readonly location: string; readonly error: ErrorInfo }[];
  readonly services: readonly { readonly capability: string; readonly plugin: string }[];
  readonly commands: readonly CommandInfo[];
  readonly hooks: readonly HookInfo[];
  readonly config: {
    readonly layers: readonly string[];
    readonly sections: readonly { readonly section: string; readonly plugin: string }[];
  };
}

/** What `Kernel.update` changed; also the payload of `kernel.plugins.updated`. */
export interface PluginsUpdate {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Plugins whose manifest or location changed. */
  readonly changed: readonly string[];
  /** Plugins deactivated, in deactivation order. */
  readonly stopped: readonly string[];
  /** Plugins activated along the new graph, in activation order (each may still fail). */
  readonly started: readonly string[];
  /** Locations whose manifest is invalid after the update. */
  readonly invalid: readonly string[];
}

export interface Kernel {
  start(sources: readonly PluginSource[]): Promise<void>;
  stop(): Promise<void>;
  /** Re-imports a plugin and re-activates it together with everything depending on it. */
  reload(pluginId: string): Promise<void>;
  /**
   * Replaces the set of plugin sources while running: validates the manifests,
   * resolves the graph again, deactivates the added, removed and changed plugins
   * and everything depending on them (in the old or the new graph), and
   * activates them along the new graph. Unrelated plugins keep running.
   *
   * An invalid manifest at a location that held a valid plugin is listed in
   * `inspect().invalid`, and that plugin keeps its previous manifest.
   */
  update(sources: readonly PluginSource[]): Promise<PluginsUpdate>;
  readonly commands: {
    execute(name: string, input: unknown, invocation?: Invocation): Promise<unknown>;
    list(): readonly CommandInfo[];
  };
  readonly config: {
    setLayer(name: string, values: Record<string, unknown>): void;
    get(section: string): unknown;
    jsonSchema(): unknown;
  };
  readonly events: {
    emit(type: string, payload?: unknown): void;
    on(type: string, listener: (payload: unknown) => void): Disposable;
    onAny(listener: (event: KernelEvent) => void): Disposable;
  };
  inspect(): KernelSnapshot;
}

interface PluginRecord {
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  status: PluginStatus;
  error: ErrorInfo | undefined;
  generation: number;
  definition: PluginDefinition | undefined;
  subscriptions: DisposableStore | undefined;
  /** `onDeactivate` cleanups of the current activation. */
  cleanups: (() => unknown)[];
}

/** A capability missing here but provided by a plugin built for the other side gets a hint. */
function withSideHint(error: ErrorInfo, otherSide: readonly PluginRecord[]): ErrorInfo {
  if (error.code !== "CAPABILITY_MISSING") return error;
  const capability = error.details?.["capability"];
  const provider = otherSide.find(
    (record) => typeof capability === "string" && capability in record.manifest.provides,
  );
  if (provider === undefined) return error;
  return {
    ...error,
    message: `${error.message}; ${provider.manifest.id} provides it but runs on the ${provider.manifest.side} side`,
    details: {
      ...error.details,
      otherSide: { plugin: provider.manifest.id, side: provider.manifest.side },
    },
  };
}

function sameSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  const left = a ?? new Set<string>();
  const right = b ?? new Set<string>();
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/** What makes two records of one plugin id the same plugin to the graph. */
function identity(record: PluginRecord): string {
  return JSON.stringify([
    record.source.location,
    record.manifest,
    record.error?.code === "DUPLICATE_PLUGIN",
  ]);
}

export function createKernel(options: KernelOptions): Kernel {
  const log = options.logger ?? noopLogger;
  const services = new ServiceRegistry();
  const commands = new CommandRegistry();
  const hooks = new HookRegistry();
  const config = new ConfigRegistry(options.configLayers ?? DEFAULT_CONFIG_LAYERS, log);
  const events = new EventBus(log);
  const states = new Map<string, Map<string, unknown>>();
  const plugins = new Map<string, PluginRecord>();
  const invalid: { location: string; error: ErrorInfo }[] = [];
  /** Activation order of the currently active plugins. */
  const activeOrder: string[] = [];
  let resolution: Resolution | undefined;
  let phase: "new" | "started" | "stopped" = "new";
  // start, stop and reload run one at a time, in call order. Calling one of them
  // from inside a plugin's activate/deactivate would wait on itself: don't.
  let lifecycle: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lifecycle.then(operation, operation);
    lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  function contextFor(record: PluginRecord, store: DisposableStore): PluginContext {
    const { manifest } = record;
    const id = manifest.id;
    const pluginLog = log.child({ plugin: id });
    // Registrations go through `own`, so a context retained after deactivation
    // (a late callback, a timer) cannot register anything that would outlive it.
    const own = <T extends Disposable>(register: () => T): T => {
      if (store.isDisposed) {
        throw new KernelError(
          "KERNEL_STATE",
          `${id} is not active; its context can no longer register anything`,
          { plugin: id },
        );
      }
      return store.add(register());
    };
    const declared = (capability: string) =>
      capability in manifest.requires ||
      capability in manifest.optional ||
      capability in manifest.provides;
    const state = states.get(id) ?? new Map<string, unknown>();
    states.set(id, state);

    return {
      plugin: { id, version: manifest.version },
      manifest,
      subscriptions: { add: (item) => store.add(item) },
      onDeactivate: (cleanup) => {
        if (store.isDisposed) {
          throw new KernelError("KERNEL_STATE", `${id} is not active; it cannot add cleanups`, {
            plugin: id,
          });
        }
        record.cleanups.push(cleanup);
      },
      services: {
        provide(capability, implementation) {
          if (!(capability in manifest.provides)) {
            throw new KernelError(
              "CAPABILITY_NOT_DECLARED",
              `${id} provides ${capability} but its manifest does not list it in "provides"`,
              { plugin: id, capability },
            );
          }
          return own(() => services.provide(id, capability, implementation));
        },
        get<T>(capability: string): T {
          if (!declared(capability)) {
            throw new KernelError(
              "CAPABILITY_NOT_DECLARED",
              `${id} uses ${capability} but its manifest does not list it in "requires" or "optional"`,
              { plugin: id, capability },
            );
          }
          if (!services.has(capability)) {
            throw new KernelError(
              "SERVICE_NOT_PROVIDED",
              `Capability ${capability} has no active implementation`,
              {
                plugin: id,
                capability,
              },
            );
          }
          return services.lookup(capability) as T;
        },
        tryGet<T>(capability: string): T | undefined {
          if (!declared(capability)) {
            throw new KernelError(
              "CAPABILITY_NOT_DECLARED",
              `${id} uses ${capability} but its manifest does not list it in "requires" or "optional"`,
              { plugin: id, capability },
            );
          }
          return services.lookup(capability) as T | undefined;
        },
      },
      hooks: {
        before: (name, hook, hookOptions) =>
          own(() => hooks.add(name, "before", id, hook as never, hookOptions?.order)),
        after: (name, hook, hookOptions) =>
          own(() => hooks.add(name, "after", id, hook as never, hookOptions?.order)),
        around: (name, hook, hookOptions) =>
          own(() => hooks.add(name, "around", id, hook as never, hookOptions?.order)),
        run: (name, input, implementation) => hooks.run(name, input, implementation),
      },
      commands: {
        register: (definition) => own(() => commands.register(id, definition as never)),
        execute: (name, input, invocation) => commands.execute(name, input, invocation),
        list: () => commands.list(),
      },
      config: {
        define: (section, schema) => own(() => config.define(id, section, schema)),
        get: <T>(section: string) => config.get(section) as T,
        onDidChange: (section, listener) =>
          own(() => config.onDidChange(section, listener as (value: unknown) => void)),
      },
      events: {
        emit: (type, payload) => events.emit(type, payload),
        on: (type, listener) => own(() => events.on(type, listener)),
      },
      state: {
        get: <T>(key: string) => state.get(key) as T | undefined,
        set: (key, value) => void state.set(key, value),
        delete: (key) => void state.delete(key),
      },
      log: pluginLog,
    };
  }

  async function activate(record: PluginRecord): Promise<void> {
    const id = record.manifest.id;
    const required = resolution?.requiredDependencies.get(id) ?? new Set<string>();
    const unavailable = [...required].find(
      (dependency) => plugins.get(dependency)?.status !== "active",
    );
    if (unavailable !== undefined) {
      record.status = "blocked";
      record.error = {
        code: "DEPENDENCY_UNAVAILABLE",
        message: `Required dependency ${unavailable} is not active`,
        details: { dependency: unavailable },
      };
      events.emit("kernel.plugin.blocked", { plugin: id, error: record.error });
      return;
    }

    record.generation += 1;
    record.cleanups = [];
    const store = new DisposableStore();
    try {
      const module = (await options.loader.load(
        record.source,
        record.manifest,
        record.generation,
      )) as {
        default?: Partial<PluginDefinition>;
      };
      const definition = module?.default;
      if (typeof definition?.activate !== "function") {
        throw new KernelError(
          "MODULE_INVALID",
          `${id}: entry module must default-export definePlugin({ activate })`,
          {
            plugin: id,
          },
        );
      }
      record.definition = definition as PluginDefinition;
      await definition.activate(contextFor(record, store));
    } catch (error) {
      await runCleanups(record);
      disposeQuietly(id, store);
      record.definition = undefined;
      record.status = "failed";
      record.error =
        error instanceof KernelError && error.code === "MODULE_INVALID"
          ? toErrorInfo(error)
          : {
              code: "ACTIVATION_FAILED",
              message: `${id} failed to activate: ${toErrorInfo(error).message}`,
              details: { cause: toErrorInfo(error) },
            };
      log.error("plugin activation failed", { plugin: id, error: record.error });
      events.emit("kernel.plugin.failed", { plugin: id, error: record.error });
      return;
    }
    record.subscriptions = store;
    record.status = "active";
    record.error = undefined;
    activeOrder.push(id);
    log.info("plugin activated", { plugin: id, version: record.manifest.version });
    events.emit("kernel.plugin.activated", { plugin: id, version: record.manifest.version });
  }

  function disposeQuietly(id: string, store: DisposableStore): void {
    try {
      store.dispose();
    } catch (error) {
      log.error("plugin dispose failed", { plugin: id, error: String(error) });
    }
  }

  async function runCleanups(record: PluginRecord): Promise<void> {
    const cleanups = record.cleanups.toReversed();
    record.cleanups = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        log.error("plugin cleanup failed", { plugin: record.manifest.id, error: String(error) });
      }
    }
  }

  async function deactivate(record: PluginRecord): Promise<void> {
    const id = record.manifest.id;
    if (record.status !== "active") return;
    await runCleanups(record);
    try {
      await record.definition?.deactivate?.();
    } catch (error) {
      log.error("plugin deactivate failed", { plugin: id, error: String(error) });
    }
    if (record.subscriptions !== undefined) disposeQuietly(id, record.subscriptions);
    record.subscriptions = undefined;
    record.definition = undefined;
    record.status = "inactive";
    activeOrder.splice(activeOrder.indexOf(id), 1);
    log.info("plugin deactivated", { plugin: id });
    events.emit("kernel.plugin.deactivated", { plugin: id });
  }

  /** `seeds` and every plugin depending on one of them, directly or not, in `graph`. */
  function dependantsOf(seeds: Iterable<string>, graph: Resolution | undefined): Set<string> {
    const result = new Set<string>(seeds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [plugin, dependencies] of graph?.dependencies ?? []) {
        if (result.has(plugin)) continue;
        if ([...dependencies].some((dependency) => result.has(dependency))) {
          result.add(plugin);
          grew = true;
        }
      }
    }
    return result;
  }

  /**
   * Validates manifests into records, one per plugin id. An invalid manifest at a
   * location in `previous` keeps that location's previous record's manifest.
   */
  function readSources(
    sources: readonly PluginSource[],
    previous: ReadonlyMap<string, PluginRecord>,
  ): { records: PluginRecord[]; invalid: { location: string; error: ErrorInfo }[] } {
    const candidates: PluginRecord[] = [];
    const rejected: { location: string; error: ErrorInfo }[] = [];
    const seen = new Map<string, PluginRecord>();
    for (const given of sources) {
      let source = given;
      let manifest: PluginManifest;
      const parsed = PluginManifest.safeParse(given.manifest);
      if (parsed.success) {
        manifest = parsed.data;
      } else {
        const kept = previous.get(given.location);
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
        rejected.push({
          location: given.location,
          error:
            kept === undefined
              ? {
                  code: "MANIFEST_INVALID",
                  message: `Invalid manifest at ${given.location}`,
                  details: { issues },
                }
              : {
                  code: "MANIFEST_INVALID",
                  message: `Invalid manifest at ${given.location}; ${kept.manifest.id} keeps its previous manifest`,
                  details: { issues, kept: kept.manifest.id },
                },
        });
        if (kept === undefined) continue;
        source = kept.source;
        manifest = kept.manifest;
      }
      const record: PluginRecord = {
        manifest,
        source,
        status: "inactive",
        error: undefined,
        generation: 0,
        definition: undefined,
        subscriptions: undefined,
        cleanups: [],
      };
      const duplicate = seen.get(manifest.id);
      if (duplicate !== undefined) {
        for (const item of [duplicate, record]) {
          item.status = "blocked";
          item.error = {
            code: "DUPLICATE_PLUGIN",
            message: `Plugin ${manifest.id} is found at ${duplicate.source.location} and ${source.location}`,
            details: { locations: [duplicate.source.location, source.location] },
          };
        }
        if (!rejected.some((item) => item.location === duplicate.source.location)) {
          rejected.push({ location: duplicate.source.location, error: duplicate.error! });
        }
        rejected.push({ location: source.location, error: record.error! });
        continue;
      }
      seen.set(manifest.id, record);
      candidates.push(record);
    }
    return { records: candidates, invalid: rejected };
  }

  /** Marks records built for the other side as skipped and graph problems as blocked. */
  function classify(records: readonly PluginRecord[]): Resolution {
    for (const record of records) {
      const side = record.manifest.side;
      if (side !== "both" && side !== options.side) record.status = "skipped";
    }
    const graph = resolveGraph(
      records.filter((record) => record.status === "inactive").map((record) => record.manifest),
    );
    const otherSide = records.filter((record) => record.status === "skipped");
    const byId = new Map(records.map((record) => [record.manifest.id, record]));
    for (const [id, error] of graph.blocked) {
      const record = byId.get(id)!;
      record.status = "blocked";
      record.error = withSideHint(error, otherSide);
      log.warn("plugin blocked", { plugin: id, error });
    }
    return graph;
  }

  return {
    start: (sources) =>
      serial(async () => {
        if (phase !== "new")
          throw new KernelError("KERNEL_STATE", "Kernel can only be started once");
        phase = "started";

        const read = readSources(sources, new Map());
        invalid.push(...read.invalid);
        for (const record of read.records) plugins.set(record.manifest.id, record);
        resolution = classify(read.records);

        for (const id of resolution.order) await activate(plugins.get(id)!);
        events.emit("kernel.started", { active: [...activeOrder] });
      }),

    stop: () =>
      serial(async () => {
        if (phase !== "started") return;
        phase = "stopped";
        for (const id of [...activeOrder].toReversed()) await deactivate(plugins.get(id)!);
        events.emit("kernel.stopped");
      }),

    reload: (pluginId) =>
      serial(async () => {
        if (phase !== "started") throw new KernelError("KERNEL_STATE", "Kernel is not running");
        const record = plugins.get(pluginId);
        if (
          record === undefined ||
          resolution === undefined ||
          !resolution.order.includes(pluginId)
        ) {
          throw new KernelError(
            "PLUGIN_NOT_FOUND",
            `Plugin ${pluginId} is not loaded or cannot activate`,
            {
              plugin: pluginId,
            },
          );
        }
        const affected = dependantsOf([pluginId], resolution);
        const toStop = [...activeOrder].toReversed().filter((id) => affected.has(id));
        for (const id of toStop) await deactivate(plugins.get(id)!);
        const toStart = resolution.order.filter((id) => affected.has(id));
        for (const id of toStart) await activate(plugins.get(id)!);
        events.emit("kernel.plugin.reloaded", { plugin: pluginId, affected: toStart });
      }),

    update: (sources) =>
      serial(async () => {
        if (phase !== "started") throw new KernelError("KERNEL_STATE", "Kernel is not running");
        const previous = new Map(
          [...plugins.values()].map((record) => [record.source.location, record]),
        );
        const read = readSources(sources, previous);
        const next = new Map(read.records.map((record) => [record.manifest.id, record]));
        const graph = classify(read.records);

        const added = [...next.keys()].filter((id) => !plugins.has(id)).toSorted();
        const removed = [...plugins.keys()].filter((id) => !next.has(id)).toSorted();
        const changed = [...next.keys()]
          .filter((id) => plugins.has(id) && identity(plugins.get(id)!) !== identity(next.get(id)!))
          .toSorted();
        const seeds = new Set([...added, ...removed, ...changed]);
        // Unchanged plugins the new graph treats differently: unblocked, newly
        // blocked, or with other dependencies (an optional capability appeared).
        for (const id of next.keys()) {
          if (!plugins.has(id)) continue;
          if (
            resolution?.blocked.has(id) !== graph.blocked.has(id) ||
            !sameSet(resolution?.dependencies.get(id), graph.dependencies.get(id))
          ) {
            seeds.add(id);
          }
        }
        const affected = new Set([
          ...dependantsOf(seeds, resolution),
          ...dependantsOf(seeds, graph),
        ]);

        const stopped = [...activeOrder].toReversed().filter((id) => affected.has(id));
        for (const id of stopped) await deactivate(plugins.get(id)!);

        const current = new Map(plugins);
        plugins.clear();
        for (const record of read.records) {
          const id = record.manifest.id;
          const kept = current.get(id);
          if (kept !== undefined && !affected.has(id)) {
            // Still blocked by the graph, maybe for another reason.
            if (record.status === "blocked") kept.error = record.error;
            plugins.set(id, kept);
            continue;
          }
          // Generations keep growing, so a re-added plugin gets fresh modules too.
          record.generation = kept?.generation ?? 0;
          plugins.set(id, record);
        }
        const invalidBefore = JSON.stringify(invalid);
        invalid.splice(0, invalid.length, ...read.invalid);
        resolution = graph;

        const started = graph.order.filter(
          (id) => affected.has(id) && plugins.get(id)!.status === "inactive",
        );
        for (const id of started) await activate(plugins.get(id)!);

        const update: PluginsUpdate = {
          added,
          removed,
          changed,
          stopped,
          started,
          invalid: invalid.map((item) => item.location),
        };
        if (seeds.size > 0 || JSON.stringify(invalid) !== invalidBefore) {
          log.info("plugins updated", { ...update });
          events.emit("kernel.plugins.updated", update);
        }
        return update;
      }),

    commands: {
      execute: (name, input, invocation) => commands.execute(name, input, invocation),
      list: () => commands.list(),
    },

    config: {
      setLayer: (name, values) => {
        config.setLayer(name, values);
        events.emit("kernel.config.changed", { layer: name });
      },
      get: (section) => config.get(section),
      jsonSchema: () => config.jsonSchema(),
    },

    events: {
      emit: (type, payload) => events.emit(type, payload),
      on: (type, listener) => events.on(type, listener),
      onAny: (listener) => events.onAny(listener),
    },

    inspect() {
      const pluginInfos: PluginInfo[] = [...plugins.values()]
        .map((record) => ({
          id: record.manifest.id,
          version: record.manifest.version,
          side: record.manifest.side,
          location: record.source.location,
          status: record.status,
          ...(record.error === undefined ? {} : { error: record.error }),
          provides: record.manifest.provides,
          requires: record.manifest.requires,
          optional: record.manifest.optional,
          dependencies: [...(resolution?.dependencies.get(record.manifest.id) ?? [])].toSorted(),
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id));
      return {
        side: options.side,
        plugins: pluginInfos,
        invalid: [...invalid],
        services: services.list(),
        commands: commands.list(),
        hooks: hooks.list(),
        config: { layers: config.layerNames, sections: config.sections() },
      };
    },
  };
}
