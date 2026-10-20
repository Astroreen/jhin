export const HOST_PATHS_CAPABILITY = "host.paths";

/** `host.paths@1`: where a node keeps files. */
export interface HostPaths {
  /** The Jhin home directory. */
  readonly home: string;
  /**
   * A directory for `plugin`'s data, created on first use. `plugin` must be a
   * plugin id; anything else (`..`, `/`) is rejected.
   */
  dataDir(plugin: string): string;
}

export const HOST_TRACE_CAPABILITY = "host.trace";

/**
 * `host.trace@1`: the trace id of the work in progress. Every log line written
 * inside `run` carries it as `traceId`, across awaits (D37).
 */
export interface HostTrace {
  run<T>(traceId: string, work: () => T): T;
  current(): string | undefined;
}

export const HOST_PLUGINS_CAPABILITY = "host.plugins";

/** A plugin package the host found on disk, for either side. */
export interface HostPlugin {
  readonly id: string;
  /** The raw `"jhin"` manifest. */
  readonly manifest: unknown;
  /** Package root on disk. */
  readonly root: string;
  readonly layer: string;
}

/**
 * `host.plugins@1`: every plugin package the host discovered, including
 * client-side plugins its own kernel skips, and changes to their files (when
 * the host watches). A plugin added, removed or with a changed manifest is
 * reported as a change to its `package.json`; `list()` already reflects it.
 */
export interface HostPlugins {
  list(): readonly HostPlugin[];
  onChange(
    listener: (change: { readonly id: string; readonly files: readonly string[] }) => void,
  ): {
    dispose(): void;
  };
}

export const HOST_IDENTITY_CAPABILITY = "host.identity";

/** `host.identity@1`: who this node is (D23). */
export interface HostIdentity {
  /** Stable for the life of the node's home. */
  readonly nodeId: string;
}

/**
 * What kind of machine a node runs on, for the icon clients show next to it
 * (T3 Code's environment machine kinds). A client that meets a kind it does
 * not know shows it as a `server`.
 */
export const MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

/** How each kind is named to people (T3 Code's labels). */
export const MACHINE_KIND_LABELS: Readonly<Record<MachineKind, string>> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export const isMachineKind = (value: unknown): value is MachineKind =>
  (MACHINE_KINDS as readonly unknown[]).includes(value);

/** The config section where a node's owner names its machine kind (`jhin.host.machine`). */
export const HOST_CONFIG_SECTION = "jhin.host";

/**
 * What `host.config.get` returns in place of a secret (a value under a
 * `writeOnly` schema); sent back in a change, it keeps the stored value
 * (security.md D417). T3 Code's `SECRET_REDACTED`.
 */
export const SECRET_REDACTED = "••••••";
