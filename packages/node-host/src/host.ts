import * as AsyncHooks from "node:async_hooks";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  configComments,
  createKernel,
  KernelError,
  parseConfigText,
  type ConfigComment,
  toErrorInfo,
  type Kernel,
  type KernelEvent,
  type KernelSnapshot,
  type ModuleLoader,
  type PluginSource,
  type PluginsUpdate,
} from "@jhin/kernel";
import {
  HOST_CONFIG_SECTION,
  HOST_IDENTITY_CAPABILITY,
  HOST_PATHS_CAPABILITY,
  HOST_PLUGINS_CAPABILITY,
  HOST_TRACE_CAPABILITY,
  type HostPaths,
  type HostPlugins,
  type HostTrace,
  MACHINE_KIND_LABELS,
  MACHINE_KINDS,
  type MachineKind,
} from "@jhin/host-api";
import {
  definePlugin,
  DOTTED_ID,
  PLUGIN_API_VERSION,
  z,
  type Disposable,
  type Logger,
  describePermissions,
} from "@jhin/sdk";
import { applyEdits, modify } from "jsonc-parser";
import { createMemoryStreams, LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { SECRETS_STORE_CAPABILITY, SecretsError, type SecretStore } from "@jhin/secrets-api";
import type { Json } from "@jhin/storage-api";

import {
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginLayers,
  type Shadowed,
} from "./discover.ts";
import { readNodeId, resolveHome, type JhinHome } from "./home.ts";
import { createFileModuleLoader } from "./loader.ts";
import { createNodeLogger, type NodeLogger } from "./logger.ts";
import { detectMachineKind, systemProbe } from "./machine.ts";
import {
  redactSecrets,
  resolveSecretReferences,
  restoreSecrets,
  scrub,
  sealSecrets,
  secretPaths,
  secretReferences,
  secretTexts,
} from "./secrets.ts";
import { buildOutputFilter, watch, type WatchTarget } from "./watcher.ts";

export interface NodeHostOptions {
  /** Jhin home directory; defaults to `$JHIN_HOME` or `~/.jhin`. */
  readonly home?: string;
  /** Project directory; its `.jhin/` holds workspace plugins and config. */
  readonly cwd?: string;
  /** Package directories of the distribution plugins. */
  readonly distribution?: readonly string[];
  readonly dev?: readonly string[];
  /**
   * Reload plugins and config when their files change (D14), and re-resolve the
   * plugin graph when a manifest changes or a plugin is added to or removed from
   * the user or workspace plugin directory (D15).
   */
  readonly watch?: boolean;
  readonly logLevel?: string;
}

export interface NodeInspection {
  readonly nodeId: string;
  readonly home: string;
  readonly logFile: string;
  readonly kernel: KernelSnapshot;
  readonly shadowed: readonly Shadowed[];
  readonly recentEvents: readonly KernelEvent[];
}

export interface NodeHost {
  readonly nodeId: string;
  readonly home: JhinHome;
  readonly kernel: Kernel;
  readonly log: NodeLogger;
  inspect(): NodeInspection;
  stop(): Promise<void>;
}

const HOST_PLUGIN = "jhin.host";
/** How far ahead of this node's clock a config change time may be (D50). */
const MAX_CONFIG_SKEW_MS = 60 * 60 * 1000;
const HOST_LOCATION = "host://jhin.host";
const HOST_STREAMS_PLUGIN = "jhin.host-streams";
const HOST_STREAMS_LOCATION = "host://jhin.host-streams";
const HOST_SECRETS_PLUGIN = "jhin.host-secrets";
const HOST_SECRETS_LOCATION = "host://jhin.host-secrets";
/** Emitted when a config file is applied with sections that changed (D483). */
const HOST_CONFIG_CHANGED = "host.config.changed";
/** The live stream clients follow for config changes (D483). */
const HOST_CONFIG_STREAM = "host/config";
/** Emitted when a device changed a section of the shared device settings (D487). */
const DEVICE_SETTINGS_CHANGED = "host.device-settings.changed";
/** The live stream clients follow for shared device settings (D487). */
const DEVICE_SETTINGS_STREAM = "host/device-settings";

/**
 * `jhin.host-streams`: the host's live streams (D483). A plugin of its own,
 * so it can use `rpc.streams@1`, which a transport provides after the host.
 */
const hostStreamsPlugin = definePlugin({
  activate(context) {
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    if (live === undefined) {
      context.log.info("no rpc.streams@1: clients hear of config changes when they read again");
      return;
    }
    const streams = createMemoryStreams({ log: context.log });
    // Nothing is kept: a client subscribes for what comes next and reads the state itself.
    context.subscriptions.add(
      live.serve(HOST_CONFIG_STREAM, streams, { permissions: ["host.config.read"] }),
    );
    context.subscriptions.add(
      live.serve(DEVICE_SETTINGS_STREAM, streams, { permissions: ["host.device-settings"] }),
    );
    for (const [type, stream] of [
      [HOST_CONFIG_CHANGED, HOST_CONFIG_STREAM],
      [DEVICE_SETTINGS_CHANGED, DEVICE_SETTINGS_STREAM],
    ] as const) {
      context.subscriptions.add(
        context.events.on(type, (payload) => {
          streams.append(stream, type, payload as Json);
          streams.clear(stream);
        }),
      );
    }
  },
});
const RECENT_EVENTS = 100;
/** The key an edit may not name: assigned, it would reach `Object.prototype`. */
const UNSAFE_KEY = "__proto__";

const Machine = z.enum(MACHINE_KINDS);
// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
const HostConfig = z
  .object({
    machine: z
      .union(
        MACHINE_KINDS.map((kind) => z.literal(kind).meta({ title: MACHINE_KIND_LABELS[kind] })) as [
          z.ZodLiteral<MachineKind>,
          ...z.ZodLiteral<MachineKind>[],
        ],
      )
      .optional()
      .meta({
        title: "Machine",
        description:
          "What this node runs on; clients show its icon next to the node. Unset, the node tells by itself, and shows as a server when it cannot.",
      }),
  })
  .meta({ title: "Host", description: "What this node says about itself." });

/** The layer in `file`; `undefined` when it cannot be parsed (the caller keeps the previous layer). */
function readLayer(file: string, log: Logger): Record<string, unknown> | undefined {
  if (!Fs.existsSync(file)) return {};
  try {
    return parseConfigText(Fs.readFileSync(file, "utf8"), file);
  } catch (error) {
    log.error("config file not applied; keeping the previous values", {
      file,
      error: toErrorInfo(error),
    });
    return undefined;
  }
}

/** The comments above the keys of `section` in `file` (D81); none when it is missing or unreadable. */
function commentsOf(file: string, section: string): ConfigComment[] {
  try {
    return Fs.existsSync(file) ? configComments(Fs.readFileSync(file, "utf8"), section) : [];
  } catch {
    return [];
  }
}

/** JSON with object keys sorted: a file whose keys only moved has not changed. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** Each layer's file as last applied, to tell which sections a change touched (D483). */
const applied = new WeakMap<Kernel, Map<string, Record<string, unknown>>>();

/**
 * What turns a layer as written into the layer applied: config secret
 * references replaced by their values (security.md D1025).
 */
const resolvers = new WeakMap<
  Kernel,
  (layer: string, values: Record<string, unknown>) => Record<string, unknown>
>();

function applyLayer(kernel: Kernel, layer: string, file: string, log: Logger): void {
  const written = readLayer(file, log);
  const resolve = resolvers.get(kernel);
  const values = written === undefined || resolve === undefined ? written : resolve(layer, written);
  let layers = applied.get(kernel);
  if (layers === undefined) applied.set(kernel, (layers = new Map()));
  if (values === undefined) {
    // Refused from the start: an empty layer is in effect, and the fix is a change of it.
    if (!layers.has(layer)) layers.set(layer, {});
    kernel.events.emit("host.config.rejected", { layer, file });
    return;
  }
  const previous = layers.get(layer);
  layers.set(layer, values);
  kernel.config.setLayer(layer, values);
  if (previous === undefined) return;
  // The sections whose part of this file changed: what clients read again (D483).
  const sections = [...new Set([...Object.keys(previous), ...Object.keys(values)])]
    .filter((section) => canonical(previous[section]) !== canonical(values[section]))
    .toSorted();
  if (sections.length > 0) kernel.events.emit(HOST_CONFIG_CHANGED, { layer, sections });
}

function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  Fs.writeFileSync(temporary, text);
  Fs.renameSync(temporary, file);
}

/** Boots a server-side kernel over the plugins found on disk. */
export async function startNodeHost(options: NodeHostOptions = {}): Promise<NodeHost> {
  const home = resolveHome(options.home);
  const nodeId = readNodeId(home);
  const traces = new AsyncHooks.AsyncLocalStorage<string>();
  const trace: HostTrace = {
    run: (traceId, work) => traces.run(traceId, work),
    current: () => traces.getStore(),
  };
  const log = createNodeLogger({
    logsDir: home.logs,
    nodeId,
    mixin: () => {
      const traceId = traces.getStore();
      return traceId === undefined ? {} : { traceId };
    },
    ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
  });
  const cwd = options.cwd ?? process.cwd();
  const projectConfig = Path.join(cwd, ".jhin", "config.jsonc");
  const layers: PluginLayers = {
    distribution: options.distribution ?? [],
    user: home.plugins,
    workspace: Path.join(cwd, ".jhin", "plugins"),
    dev: options.dev ?? [],
  };
  let discovery = discoverPlugins(layers);

  const recentEvents: KernelEvent[] = [];
  const pluginListeners = new Set<
    (change: { readonly id: string; readonly files: readonly string[] }) => void
  >();
  // Assigned right after the kernel exists; the host plugin only runs after that.
  let kernel!: Kernel;

  const hostPlugin = definePlugin({
    activate(context) {
      const paths: HostPaths = {
        home: home.root,
        cwd,
        dataDir(plugin) {
          if (!DOTTED_ID.test(plugin)) {
            throw new Error(`dataDir needs a plugin id, got ${JSON.stringify(plugin)}`);
          }
          const dir = Path.join(home.root, "data", plugin);
          Fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
      };
      context.services.provide(HOST_PATHS_CAPABILITY, paths);
      context.services.provide(HOST_TRACE_CAPABILITY, trace);
      context.services.provide(HOST_IDENTITY_CAPABILITY, { nodeId });
      context.config.define(HOST_CONFIG_SECTION, HostConfig);
      // Detected once, on first ask: on macOS it runs a process.
      let detection: Promise<MachineKind | null> | undefined;
      const plugins: HostPlugins = {
        list: () =>
          discovery.plugins.flatMap((plugin) => {
            const id = (plugin.manifest as { id?: unknown } | undefined)?.id;
            return typeof id === "string"
              ? [{ id, manifest: plugin.manifest, root: plugin.root, layer: plugin.layer }]
              : [];
          }),
        onChange(listener) {
          pluginListeners.add(listener);
          return { dispose: () => pluginListeners.delete(listener) };
        },
      };
      context.services.provide(HOST_PLUGINS_CAPABILITY, plugins);
      // The titles of this plugin's permissions (security.md D961).
      describePermissions(context, {
        "host.config.read": {
          title: "View settings",
          description: "Read this node's config and its schemas.",
        },
        "host.config.write": {
          title: "Change environment settings",
          description: "Edit this node's config.",
        },
        "host.inspect": {
          title: "View diagnostics",
          description: "Read plugins, services, commands, hooks and recent events.",
        },
        "host.identity": {
          title: "View identity",
          description: "Read this node's id and machine.",
        },
        "host.plugins.reload": {
          title: "Maintain environment",
          description: "Reload and rescan plugins.",
        },
      });
      context.commands.register({
        name: "host.inspect",
        description:
          "Live state of this node: plugins, services, commands, hooks, config and recent events",
        input: z.object({}),
        output: z.unknown(),
        permissions: ["host.inspect"],
        handler: () => inspect(),
      });
      context.commands.register({
        name: "host.identity",
        description:
          "What this node is: its id, host name, platform and the machine kind clients show it as (the owner's choice in jhin.host, else what the node detects, else a server)",
        input: z.object({}),
        output: z.object({
          nodeId: z.string(),
          hostname: z.string(),
          /** Node's `process.platform` and `process.arch`. */
          platform: z.string(),
          arch: z.string(),
          machine: Machine,
          /** What the node tells by itself; absent when it cannot. */
          detectedMachine: Machine.optional(),
        }),
        // Its own permission, as `host.inspect` has: the host name says something about the machine.
        permissions: ["host.identity"],
        handler: async () => {
          const detected = await (detection ??= detectMachineKind(systemProbe));
          let chosen: MachineKind | undefined;
          try {
            chosen = context.config.get<z.output<typeof HostConfig>>(HOST_CONFIG_SECTION).machine;
          } catch {
            // An invalid section chooses nothing; `host.config.get` says what is wrong.
          }
          return {
            nodeId,
            hostname: Os.hostname(),
            platform: process.platform,
            arch: process.arch,
            machine: chosen ?? detected ?? "server",
            ...(detected === null ? {} : { detectedMachine: detected }),
          };
        },
      });
      context.commands.register({
        name: "host.commands.list",
        description: "Every command on this node, with JSON Schemas of input and output",
        input: z.object({}),
        output: z.unknown(),
        handler: () => context.commands.list(),
      });
      context.commands.register({
        name: "host.config.patch",
        description:
          "Changes this node's node or project config file, keeping its comments; refuses a change older than the last one (D50)",
        input: z.object({
          layer: z.enum(["node", "project"]),
          section: z.string().regex(DOTTED_ID),
          values: z.record(
            z.string().refine((key) => key !== UNSAFE_KEY),
            z.unknown(),
          ),
          /** Keys to remove from the section in the file, so they take their default again (D84). */
          unset: z.array(z.string().refine((key) => key !== UNSAFE_KEY)).optional(),
          /** When the change was made (ms); later changes win. Defaults to now. */
          at: z.number().int().nonnegative().optional(),
        }),
        output: z.object({
          applied: z.boolean(),
          at: z.number(),
          conflict: z.object({ localAt: z.number() }).optional(),
        }),
        permissions: ["host.config.write"],
        handler: ({ layer, section, values, unset, at }) =>
          patchConfig(layer, section, values, unset ?? [], at ?? Date.now()),
      });
      context.commands.register({
        name: "host.config.edit",
        description:
          "Changes values at paths inside a section of this node's node or project config file, keeping every comment outside what changed; refuses a change older than the last one (D50)",
        input: z.object({
          layer: z.enum(["node", "project"]),
          section: z.string().regex(DOTTED_ID),
          /** Applied in order; an edit without `value` removes its key (D476). */
          edits: z.array(
            z.object({
              path: z.array(z.string().refine((key) => key !== UNSAFE_KEY)).min(1),
              value: z.unknown().optional(),
            }),
          ),
          /**
           * The changed top-level keys whole, as the sender's file holds them:
           * written instead of an edit whose parent is no object in this file.
           */
          values: z
            .record(
              z.string().refine((key) => key !== UNSAFE_KEY),
              z.unknown(),
            )
            .optional(),
          /** When the change was made (ms); later changes win. Defaults to now. */
          at: z.number().int().nonnegative().optional(),
        }),
        output: z.object({
          applied: z.boolean(),
          at: z.number(),
          conflict: z.object({ localAt: z.number() }).optional(),
        }),
        permissions: ["host.config.write"],
        handler: ({ layer, section, edits, values, at }) =>
          editConfig(layer, section, edits, values, at ?? Date.now()),
      });
      context.commands.register({
        name: "host.config.secrets.migrate",
        description:
          "Moves every secret written in clear in this node's node and project config files (or one of them) into the node's secret store, leaving a reference in the file; returns where they were, never what (security.md D1027)",
        input: z.object({ layer: z.enum(["node", "project"]).optional() }),
        output: z.object({
          moved: z.array(
            z.object({
              layer: z.enum(["node", "project"]),
              section: z.string(),
              path: z.array(z.union([z.string(), z.number()])),
            }),
          ),
        }),
        permissions: ["host.config.write"],
        handler: ({ layer }) => migrateSecrets(layer === undefined ? ["node", "project"] : [layer]),
      });
      context.commands.register({
        name: "host.config.get",
        description:
          "A config section of this node: its effective value, what the node and project files set, and the comments above their keys",
        input: z.object({ section: z.string().regex(DOTTED_ID) }),
        output: z.object({
          /** Absent when the section is not defined or its value is invalid. */
          value: z.unknown().optional(),
          error: z.string().optional(),
          /** Why the effective value is invalid, by path inside the section (D84). */
          issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
          layers: z.object({ node: z.unknown().optional(), project: z.unknown().optional() }),
          /**
           * The comment directly above each key of the section in the node
           * file, then in the project file; the first for a path counts (D81).
           */
          comments: z.array(z.object({ path: z.array(z.string()).readonly(), text: z.string() })),
        }),
        permissions: ["host.config.read"],
        handler: ({ section }) => {
          // Secrets never leave the node (security.md D417).
          const schema = sectionSchema(section);
          const hide = (value: unknown) => redactSecrets(schema, value);
          const raw = {
            node: readLayer(home.config, log)?.[section],
            project: readLayer(projectConfig, log)?.[section],
          };
          const files = { node: hide(raw.node), project: hide(raw.project) };
          // A refinement's message may quote the value it refused: the files' text,
          // and the values their secret references resolve to (D1026).
          const resolved = applied.get(kernel);
          const secrets = [
            ...secretTexts(schema, raw.node),
            ...secretTexts(schema, raw.project),
            ...secretTexts(schema, resolved?.get("node")?.[section]),
            ...secretTexts(schema, resolved?.get("project")?.[section]),
          ];
          // Issue paths are dotted, as the kernel reports them.
          const secretAt = new Set(
            [...secretPaths(schema, raw.node), ...secretPaths(schema, raw.project)].map((path) =>
              path.join("."),
            ),
          );
          /** An issue about a secret says so without its own message, which may quote it. */
          const aboutSecret = (path: string) =>
            [...secretAt].some((secret) => path === secret || path.startsWith(`${secret}.`));
          const comments: ConfigComment[] = [];
          const seen = new Set<string>();
          for (const file of [home.config, projectConfig]) {
            for (const comment of commentsOf(file, section)) {
              const key = JSON.stringify(comment.path);
              if (seen.has(key)) continue;
              seen.add(key);
              comments.push(comment);
            }
          }
          try {
            return { value: hide(kernel.config.get(section)), layers: files, comments };
          } catch (error) {
            const issues =
              error instanceof KernelError && Array.isArray(error.details["issues"])
                ? (error.details["issues"] as { path: string; message: string }[])
                : undefined;
            return {
              // An invalid value: the summary without the issues' messages, which may
              // quote a secret. Anything else (a section no plugin defines) as it is.
              error:
                error instanceof KernelError && error.code === "CONFIG_INVALID"
                  ? `Config section ${section} is invalid${issues === undefined ? "" : ` (${issues.length} ${issues.length === 1 ? "issue" : "issues"})`}`
                  : error instanceof Error
                    ? error.message
                    : String(error),
              ...(issues === undefined
                ? {}
                : {
                    issues: issues.map((issue) => ({
                      path: issue.path,
                      message: aboutSecret(issue.path)
                        ? "Not valid (a secret, so its message is not shown)"
                        : scrub(issue.message, secrets),
                    })),
                  }),
              layers: files,
              comments,
            };
          }
        },
      });
      const DeviceSection = z.object({
        values: z.record(z.string(), z.unknown()),
        /** When a device last changed it (ms on that device); the later change wins. */
        at: z.number().int().nonnegative(),
      });
      const deviceSettingsFile = Path.join(home.root, "device-settings.json");
      /** What the file keeps; `undefined` when it is there but unreadable, so nothing overwrites it. */
      const readDeviceSettings = (): Record<string, z.output<typeof DeviceSection>> | undefined => {
        if (!Fs.existsSync(deviceSettingsFile)) return {};
        try {
          const parsed = z
            .record(z.string(), DeviceSection)
            .safeParse(JSON.parse(Fs.readFileSync(deviceSettingsFile, "utf8")));
          return parsed.success ? parsed.data : undefined;
        } catch {
          return undefined;
        }
      };
      context.commands.register({
        name: "host.device-settings.get",
        description:
          "The device settings this node keeps for its owner's devices, by section, each with when it last changed (D487)",
        input: z.object({}),
        output: z.object({ sections: z.record(z.string(), DeviceSection) }),
        permissions: ["host.device-settings"],
        handler: () => ({ sections: readDeviceSettings() ?? {} }),
      });
      context.commands.register({
        name: "host.device-settings.patch",
        description:
          "Keeps a device's settings of one section for the owner's other devices; an older change than the kept one is ignored (D487)",
        input: z.object({ section: z.string().regex(DOTTED_ID) }).extend(DeviceSection.shape),
        output: z.object({ applied: z.boolean() }),
        permissions: ["host.device-settings"],
        handler: ({ section, values, at }) => {
          // Settings, not storage: a section is small, and so is the file.
          if (JSON.stringify(values).length > 64 * 1024) {
            throw Object.assign(new Error("A device settings section is limited to 64 kB"), {
              code: "DEVICE_SETTINGS_TOO_LARGE",
            });
          }
          const kept = readDeviceSettings();
          if (kept === undefined) {
            // A damaged file is the owner's to look at: overwriting it would drop every section.
            throw Object.assign(
              new Error(`${deviceSettingsFile} cannot be read; fix or remove it`),
              {
                code: "DEVICE_SETTINGS_UNREADABLE",
              },
            );
          }
          if (kept[section] === undefined && Object.keys(kept).length >= 200) {
            throw Object.assign(new Error("A node keeps at most 200 device settings sections"), {
              code: "DEVICE_SETTINGS_TOO_LARGE",
            });
          }
          const current = kept[section];
          if (current !== undefined && current.at >= at) return { applied: false };
          kept[section] = { values, at };
          writeAtomically(deviceSettingsFile, `${JSON.stringify(kept, null, 2)}\n`);
          context.events.emit(DEVICE_SETTINGS_CHANGED, { section, values, at });
          return { applied: true };
        },
      });
      context.commands.register({
        name: "host.config.schema",
        description: "JSON Schema of every config section of this node, keyed by section",
        input: z.object({}),
        output: z.unknown(),
        permissions: ["host.config.read"],
        handler: () => kernel.config.jsonSchema(),
      });
      context.commands.register({
        name: "host.plugins.rescan",
        description:
          "Finds plugins on disk again: activates added ones, stops removed ones and re-resolves changed manifests with everything depending on them",
        input: z.object({}),
        output: z.object({
          added: z.array(z.string()).readonly(),
          removed: z.array(z.string()).readonly(),
          changed: z.array(z.string()).readonly(),
          stopped: z.array(z.string()).readonly(),
          started: z.array(z.string()).readonly(),
          invalid: z.array(z.string()).readonly(),
        }),
        permissions: ["host.plugins.reload"],
        handler: () => rescan(),
      });
      context.commands.register({
        name: "host.plugins.reload",
        description: "Re-imports a plugin and re-activates it with everything depending on it",
        input: z.object({ plugin: z.string() }),
        output: z.object({ plugin: z.string() }),
        permissions: ["host.plugins.reload"],
        handler: async ({ plugin }) => {
          await kernel.reload(plugin);
          return { plugin };
        },
      });
    },
  });

  /** The node's secret store while one is active (security.md D1025). */
  let secretStore: SecretStore | undefined;
  // Activated after `secrets.store` (an optional dependency), and again with it.
  const hostSecretsPlugin = definePlugin({
    activate(context) {
      const store = context.services.tryGet<SecretStore>(SECRETS_STORE_CAPABILITY);
      if (store === undefined) return;
      secretStore = store;
      context.onDeactivate(() => {
        if (secretStore === store) secretStore = undefined;
      });
      // The layers again, now that their references resolve.
      applyLayer(kernel, "node", home.config, log);
      applyLayer(kernel, "project", projectConfig, log);
    },
  });

  const fileLoader = createFileModuleLoader();
  const loader: ModuleLoader = {
    load: (source, manifest, generation) =>
      source.location === HOST_LOCATION
        ? Promise.resolve({ default: hostPlugin })
        : source.location === HOST_STREAMS_LOCATION
          ? Promise.resolve({ default: hostStreamsPlugin })
          : source.location === HOST_SECRETS_LOCATION
            ? Promise.resolve({ default: hostSecretsPlugin })
            : fileLoader.load(source, manifest, generation),
  };
  kernel = createKernel({ side: "server", loader, logger: log });
  resolvers.set(kernel, (layer, values) => {
    const store = secretStore;
    return resolveSecretReferences(
      values,
      store === undefined
        ? undefined
        : (reference, [section, ...path]) =>
            store.resolveConfig(reference, { section: String(section), path }),
      (place) => {
        // Before the store is active every reference waits for it; that is no news.
        if (store === undefined) return;
        log.warn("config secret not found in the secret store; the key is left out", {
          layer,
          section: place[0],
          path: place.slice(1),
        });
      },
    );
  });
  kernel.events.onAny((event) => {
    recentEvents.push(event);
    if (recentEvents.length > RECENT_EVENTS) recentEvents.shift();
  });

  applyLayer(kernel, "node", home.config, log);
  applyLayer(kernel, "project", projectConfig, log);

  const hostSource: PluginSource = {
    location: HOST_LOCATION,
    manifest: {
      id: HOST_PLUGIN,
      version: "0.0.0",
      apiVersion: PLUGIN_API_VERSION,
      side: "server",
      provides: {
        [HOST_PATHS_CAPABILITY]: "1.1.0",
        [HOST_TRACE_CAPABILITY]: "1.0.0",
        [HOST_PLUGINS_CAPABILITY]: "1.0.0",
        [HOST_IDENTITY_CAPABILITY]: "1.0.0",
      },
      entry: "host",
    },
  };
  const hostStreamsSource: PluginSource = {
    location: HOST_STREAMS_LOCATION,
    manifest: {
      id: HOST_STREAMS_PLUGIN,
      version: "0.0.0",
      apiVersion: PLUGIN_API_VERSION,
      side: "server",
      provides: {},
      optional: { [LIVE_STREAMS_CAPABILITY]: "^1" },
      entry: "host-streams",
    },
  };
  const hostSecretsSource: PluginSource = {
    location: HOST_SECRETS_LOCATION,
    manifest: {
      id: HOST_SECRETS_PLUGIN,
      version: "0.0.0",
      apiVersion: PLUGIN_API_VERSION,
      side: "server",
      provides: {},
      optional: { [SECRETS_STORE_CAPABILITY]: "^1" },
      entry: "host-secrets",
    },
  };
  await kernel.start([hostSource, hostStreamsSource, hostSecretsSource, ...discovery.plugins]);

  const notifyPlugin = (id: string, files: readonly string[]) => {
    for (const listener of Array.from(pluginListeners)) {
      // One failing listener must not stop the others, nor fail the change that was applied.
      try {
        listener({ id, files });
      } catch (error) {
        log.error("host.plugins listener failed", { plugin: id, error: toErrorInfo(error) });
      }
    }
  };

  let rescans: Promise<unknown> = Promise.resolve();
  /**
   * Discovers plugins again and applies the differences to the running kernel.
   * Rescans run one at a time, so each discovers after the previous one applied
   * and the last one leaves `discovery` and the watchers matching the kernel.
   */
  function rescan(): Promise<PluginsUpdate> {
    const run = rescans.then(rescanNow, rescanNow);
    rescans = run.catch(() => undefined);
    return run;
  }

  async function rescanNow(): Promise<PluginsUpdate> {
    const previous = discovery.plugins;
    const next = discoverPlugins(layers);
    const found = next.plugins;
    const update = await kernel.update([
      hostSource,
      hostStreamsSource,
      hostSecretsSource,
      ...found,
    ]);
    // Only what the kernel applied becomes the discovery the watchers follow.
    discovery = next;
    rewatch();
    // Client plugins are skipped here; listeners (the web UI) tell their clients.
    // A removed plugin is reported with its former manifest file.
    for (const [ids, plugins] of [
      [[...update.added, ...update.changed], found],
      [update.removed, previous],
    ] as const) {
      for (const id of ids) {
        const plugin = plugins.find(
          (candidate) => (candidate.manifest as { id?: unknown } | undefined)?.id === id,
        );
        if (plugin !== undefined) notifyPlugin(id, [Path.join(plugin.root, "package.json")]);
      }
    }
    return update;
  }

  /** Last write time per layer and section, so a stale change from elsewhere can lose (D50). */
  const writesFile = Path.join(home.root, "config-writes.json");
  /** One section's JSON Schema, or undefined when no plugin defines it (D417 reads it). */
  function sectionSchema(section: string): unknown {
    return (kernel.config.jsonSchema() as { properties: Record<string, unknown> }).properties[
      section
    ];
  }

  const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  /**
   * Writes a change to a layer's file unless a later one was written there
   * (D50); `change` turns the file's text into the new text.
   */
  function writeConfig(
    layer: "node" | "project",
    section: string,
    at: number,
    change: (text: string, file: string) => string,
  ): { applied: boolean; at: number; conflict?: { localAt: number } } {
    let writes: Record<string, Record<string, number>> = {};
    try {
      if (Fs.existsSync(writesFile))
        writes = JSON.parse(Fs.readFileSync(writesFile, "utf8")) as typeof writes;
    } catch (error) {
      // A damaged record of write times must not block every later change.
      log.warn("config write times unreadable; starting over", {
        file: writesFile,
        error: String(error),
      });
    }
    // A time far ahead would lock the section against every later change.
    if (at > Date.now() + MAX_CONFIG_SKEW_MS) {
      throw Object.assign(
        new Error(`Change time ${at} is more than an hour ahead of this node's clock`),
        {
          code: "CONFIG_TIME_IN_FUTURE",
        },
      );
    }
    const localAt = writes[layer]?.[section];
    if (localAt !== undefined && at < localAt) return { applied: false, at, conflict: { localAt } };

    const file = layer === "node" ? home.config : projectConfig;
    const original = Fs.existsSync(file) ? Fs.readFileSync(file, "utf8") : "{}\n";
    const text = change(original, file);
    Fs.mkdirSync(Path.dirname(file), { recursive: true });
    // Times first, then the file, each replaced atomically: a crash in between
    // can only make a later stale change lose, never win.
    writes[layer] = { ...writes[layer], [section]: at };
    writeAtomically(writesFile, `${JSON.stringify(writes, null, 2)}\n`);
    writeAtomically(file, text);
    forgetRemovedSecrets(original, text, file);
    applyLayer(kernel, layer, file, log);
    return { applied: true, at };
  }

  /** The config secret references `text` (a config file) holds; none when it does not parse. */
  function referencesIn(text: string, file: string): Set<string> {
    try {
      return new Set(secretReferences(parseConfigText(text, file)));
    } catch {
      return new Set();
    }
  }

  /**
   * Deletes from the store what a change took out of a file, unless the
   * other layer's file still names it (security.md D1026).
   */
  function forgetRemovedSecrets(before: string, after: string, file: string): void {
    const store = secretStore;
    if (store === undefined) return;
    const kept = referencesIn(after, file);
    const removed = [...referencesIn(before, file)].filter((reference) => !kept.has(reference));
    if (removed.length === 0) return;
    const other = file === home.config ? projectConfig : home.config;
    const elsewhere = Fs.existsSync(other)
      ? referencesIn(Fs.readFileSync(other, "utf8"), other)
      : new Set<string>();
    for (const reference of removed) {
      if (elsewhere.has(reference)) continue;
      try {
        store.deleteConfig(reference);
      } catch (error) {
        log.warn("could not delete a config secret from the secret store", {
          error: String(error),
        });
      }
    }
  }

  /**
   * `values` (top-level keys of a section) with every secret in clear put into
   * the secret store and replaced by its reference (security.md D1026); as
   * they are without a store.
   */
  function sealed(section: string, values: Record<string, unknown>): Record<string, unknown> {
    const store = secretStore;
    if (store === undefined) return values;
    return sealSecrets(sectionSchema(section), values, (text, path) =>
      store.putConfig(text, { section, path }),
    );
  }

  /** Moves the secrets in clear of `layers`' files into the store (security.md D1027). */
  function migrateSecrets(targets: readonly ("node" | "project")[]) {
    const store = secretStore;
    if (store === undefined) throw new SecretsError("SECRET_STORE_UNAVAILABLE");
    const moved: { layer: "node" | "project"; section: string; path: (string | number)[] }[] = [];
    for (const layer of targets) {
      const file = layer === "node" ? home.config : projectConfig;
      const sections = readLayer(file, log);
      if (sections === undefined) continue;
      for (const [section, value] of Object.entries(sections)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const schema = sectionSchema(section);
        const places: { path: (string | number)[]; reference: string }[] = [];
        // Found first, stored only once the file is written: a refused write keeps nothing.
        sealSecrets(schema, value as Record<string, unknown>, (_text, path) => {
          places.push({ path: [...path], reference: "" });
          return "";
        });
        if (places.length === 0) continue;
        writeConfig(layer, section, Date.now(), (original, path) => {
          let text = original;
          const current = parseConfigText(text, path)[section];
          for (const place of places) {
            let leaf: unknown = current;
            for (const key of place.path) leaf = (leaf as Record<string | number, unknown>)?.[key];
            if (typeof leaf !== "string") continue;
            place.reference = store.putConfig(leaf, { section, path: place.path });
            // A leaf edit: every comment of the file stays.
            text = applyEdits(
              text,
              modify(text, [section, ...place.path], place.reference, formatting),
            );
          }
          return text;
        });
        for (const place of places) {
          if (place.reference !== "") moved.push({ layer, section, path: place.path });
        }
      }
    }
    return { moved };
  }

  /**
   * `values` (top-level keys of a section) with each redacted secret sent
   * back replaced by what the layer holds (security.md D417).
   */
  function withSecrets(
    layer: "node" | "project",
    section: string,
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const file = layer === "node" ? home.config : projectConfig;
    const stored = readLayer(file, log)?.[section];
    // The page shows the effective value: a secret only another layer sets stays there.
    let effective: unknown;
    try {
      effective = kernel.config.get(section);
    } catch {
      // An invalid section has no effective value to keep a secret from.
    }
    return restoreSecrets(sectionSchema(section), { ...values }, stored, effective, [section]);
  }

  function patchConfig(
    layer: "node" | "project",
    section: string,
    values: Record<string, unknown>,
    unset: readonly string[],
    at: number,
  ) {
    return writeConfig(layer, section, at, (original, file) => {
      let text = original;
      for (const [key, value] of Object.entries(
        sealed(section, withSecrets(layer, section, values)),
      )) {
        text = applyEdits(text, modify(text, [section, key], value, formatting));
      }
      // Removed only where the section is an object: `modify` would replace anything else.
      const current = unset.length === 0 ? undefined : parseConfigText(text, file)[section];
      if (typeof current === "object" && current !== null && !Array.isArray(current)) {
        for (const key of unset) {
          if (!Object.hasOwn(current, key) || Object.hasOwn(values, key)) continue;
          text = applyEdits(text, modify(text, [section, key], undefined, formatting));
        }
      }
      return text;
    });
  }

  /**
   * Applies edits of leaf paths (D476), so the comments of everything else
   * stay, even inside a changed key. An edit whose parent is no object in the
   * file (it changed since the edit was made) replaces that parent with an
   * object holding the edit. Removing what the file does not hold is done:
   * the key is not there, as asked (D475).
   */
  function editConfig(
    layer: "node" | "project",
    section: string,
    edits: readonly { path: readonly string[]; value?: unknown }[],
    values: Readonly<Record<string, unknown>> | undefined,
    at: number,
  ) {
    // Secrets sent back redacted keep what the file holds, at their full path (D417).
    const restoredValues = values === undefined ? undefined : withSecrets(layer, section, values);
    const restoredEdits = edits.map((edit) => {
      if (!Object.hasOwn(edit, "value")) return edit;
      let wrapped: unknown = edit.value;
      for (const key of edit.path.slice(1).toReversed()) wrapped = { [key]: wrapped };
      const top = edit.path[0]!;
      let value: unknown = withSecrets(layer, section, { [top]: wrapped })[top];
      for (const key of edit.path.slice(1)) {
        // The restored value keeps the edit's shape; anything else leaves the edit as sent.
        if (typeof value !== "object" || value === null || Array.isArray(value)) return edit;
        value = (value as Record<string, unknown>)[key];
      }
      return { path: edit.path, value };
    });
    return writeConfig(layer, section, at, (original, file) => {
      let text = original;
      // Secrets in clear go to the store; the file gets their references (D1026).
      const sealedValues =
        restoredValues === undefined ? undefined : sealed(section, restoredValues);
      const sealedEdits = restoredEdits.map((edit) => {
        if (!Object.hasOwn(edit, "value")) return edit;
        let wrapped: unknown = edit.value;
        for (const key of edit.path.slice(1).toReversed()) wrapped = { [key]: wrapped };
        let value: unknown = sealed(section, { [edit.path[0]!]: wrapped })[edit.path[0]!];
        for (const key of edit.path.slice(1)) value = (value as Record<string, unknown>)[key];
        return { path: edit.path, value };
      });
      /** Top-level keys written whole: the edits below them are in that value already. */
      const whole = new Set<string>();
      for (const edit of sealedEdits) {
        const path = [section, ...edit.path];
        if (whole.has(edit.path[0]!)) continue;
        const parsed = parseConfigText(text, file);
        // The deepest object along the path: what is below it is written whole.
        let depth = 0;
        let parent: unknown = parsed;
        while (depth < path.length - 1) {
          const next = (parent as Record<string, unknown>)[path[depth]!];
          if (typeof next !== "object" || next === null || Array.isArray(next)) break;
          parent = next;
          depth += 1;
        }
        if (depth < path.length - 1) {
          // This file has no object where the sender's had one: the sender's whole
          // top-level key is written, so siblings the sender showed come along (D476).
          const top = edit.path[0]!;
          if (sealedValues !== undefined && Object.hasOwn(sealedValues, top)) {
            whole.add(top);
            text = applyEdits(text, modify(text, [section, top], sealedValues[top], formatting));
            continue;
          }
          if (!Object.hasOwn(edit, "value")) continue;
          let value: unknown = edit.value;
          for (const key of path.slice(depth + 1).toReversed()) value = { [key]: value };
          text = applyEdits(text, modify(text, path.slice(0, depth + 1), value, formatting));
          continue;
        }
        const key = path.at(-1)!;
        if (!Object.hasOwn(edit, "value") && !Object.hasOwn(parent as object, key)) continue;
        text = applyEdits(
          text,
          modify(text, path, Object.hasOwn(edit, "value") ? edit.value : undefined, formatting),
        );
      }
      return text;
    });
  }

  function inspect(): NodeInspection {
    return {
      nodeId,
      home: home.root,
      logFile: log.file,
      kernel: kernel.inspect(),
      shadowed: discovery.shadowed,
      recentEvents: [...recentEvents],
    };
  }

  /** Live watchers by target key; see `watchTargets`. */
  const watchers = new Map<string, Disposable>();
  let stopping = false;
  const locations = [layers.user, layers.workspace].filter((dir) => dir !== undefined);
  /**
   * Starts watchers for new targets and stops those of targets that are gone.
   * The others keep running, so their pending changes are not lost.
   */
  function rewatch(): void {
    if (options.watch !== true || stopping) return;
    const targets = watchTargets({
      kernel,
      plugins: discovery.plugins,
      locations,
      home,
      projectConfig,
      log,
      notify: notifyPlugin,
      rescan,
      hasOwnWatcher: (location) =>
        discovery.plugins.some(
          (plugin) =>
            plugin.location === location &&
            typeof (plugin.manifest as { id?: unknown } | undefined)?.id === "string",
        ),
    });
    for (const [key, watcher] of watchers) {
      if (targets.has(key)) continue;
      watcher.dispose();
      watchers.delete(key);
    }
    for (const [key, target] of targets) {
      if (!watchers.has(key)) watchers.set(key, watch([target], log));
    }
  }
  rewatch();

  return {
    nodeId,
    home,
    kernel,
    log,
    inspect,
    async stop() {
      stopping = true;
      for (const watcher of watchers.values()) watcher.dispose();
      watchers.clear();
      // A rescan already queued applies before the kernel stops, not after.
      await rescans;
      await kernel.stop();
      log.flush();
    },
  };
}

interface WatchFilesOptions {
  readonly kernel: Kernel;
  readonly plugins: readonly DiscoveredPlugin[];
  /** Directories whose subdirectories are plugins (D15): watched for plugins coming and going. */
  readonly locations: readonly string[];
  readonly home: JhinHome;
  readonly projectConfig: string;
  readonly log: Logger;
  readonly notify: (id: string, files: readonly string[]) => void;
  readonly rescan: () => Promise<PluginsUpdate>;
  /** Whether the plugin directory at `location` has a watcher of its own (it was discovered). */
  readonly hasOwnWatcher: (location: string) => boolean;
}

/** What to watch, by a key that changes when the target must be watched anew. */
function watchTargets({
  kernel,
  plugins,
  locations,
  home,
  projectConfig,
  log,
  notify,
  rescan,
  hasOwnWatcher,
}: WatchFilesOptions): Map<string, WatchTarget> {
  const rescanQuietly = (reason: string) =>
    rescan().catch((error: unknown) => {
      log.error("plugin rescan failed", { reason, error: toErrorInfo(error) });
      return undefined;
    });
  const reload = (id: string, files: readonly string[], notified = false) => {
    if (!notified) notify(id, files);
    // Client-side plugins are skipped by this kernel; their clients reload them.
    // A blocked plugin cannot run whatever its code; a failed one is retried.
    const status = kernel.inspect().plugins.find((candidate) => candidate.id === id)?.status;
    if (status === undefined || status === "skipped" || status === "blocked") return;
    log.info("plugin files changed, reloading", { plugin: id, files });
    kernel.reload(id).catch((error: unknown) => {
      log.error("plugin reload failed", { plugin: id, error: toErrorInfo(error) });
    });
  };
  const targets = new Map<string, WatchTarget>();
  for (const plugin of plugins) {
    const id = (plugin.manifest as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") continue;
    const manifestFile = Path.join(plugin.root, "package.json");
    const entry = String((plugin.manifest as { entry?: unknown } | undefined)?.entry ?? "");
    const filter = buildOutputFilter(entry);
    // The entry kind is part of the key: a manifest whose entry switches between
    // TypeScript and JavaScript gets a fresh watcher with the right filter.
    const kind = /\.[cm]?tsx?$/.test(entry) ? "source" : "built";
    targets.set(`plugin:${id}:${plugin.root}:${kind}`, {
      path: plugin.root,
      filter,
      onChange: (files) => {
        if (!files.includes(manifestFile)) {
          reload(id, files);
          return;
        }
        log.info("plugin manifest changed, re-resolving the plugin graph", { plugin: id });
        void rescanQuietly(`manifest of ${id} changed`).then((update) => {
          const rest = files.filter((file) => file !== manifestFile);
          if (rest.length === 0) return;
          if (update !== undefined && (update.started.includes(id) || update.removed.includes(id)))
            return;
          // A failed rescan, or a manifest saved unchanged, still reloads the code saved with it.
          // A rescan already told listeners about an added or changed plugin.
          const notified =
            update !== undefined && (update.added.includes(id) || update.changed.includes(id));
          reload(id, rest, notified);
        });
      },
    });
  }
  for (const path of locations) {
    // A location created later is watched itself once it exists, not through its parent.
    targets.set(`location:${path}:${Fs.existsSync(path)}`, {
      path,
      // A plugin directory coming or going, or the manifest of one (maybe not discovered yet).
      filter: (relative) => {
        const parts = relative.split(Path.sep);
        // Discovery skips hidden entries.
        if (parts[0]!.startsWith(".")) return false;
        // A discovered plugin's own watcher handles its manifest; reacting here
        // too would rescan twice for one save.
        if (parts.length === 2) {
          return parts[1] === "package.json" && !hasOwnWatcher(Path.join(path, parts[0]!));
        }
        if (parts.length !== 1) return false;
        // A file beside the plugin directories (an editor's temp file) is no plugin;
        // an entry that is gone may have been one.
        return Fs.statSync(Path.join(path, relative), { throwIfNoEntry: false })?.isFile() !== true;
      },
      onChange: () => void rescanQuietly(`plugins changed in ${path}`),
    });
  }
  targets.set("config:node", {
    path: home.config,
    onChange: () => applyLayer(kernel, "node", home.config, log),
  });
  targets.set("config:project", {
    path: projectConfig,
    onChange: () => applyLayer(kernel, "project", projectConfig, log),
  });
  return targets;
}
