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
