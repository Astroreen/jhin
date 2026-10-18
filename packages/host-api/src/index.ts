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
