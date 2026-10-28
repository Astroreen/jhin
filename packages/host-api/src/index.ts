export const HOST_PATHS_CAPABILITY = "host.paths";

/** `host.paths@1`: where a node keeps files. */
export interface HostPaths {
  /** The Jhin home directory. */
  readonly home: string;
  /**
   * The project directory the node runs in (`jhin --cwd`), whose `.jhin/`
   * holds the project config layer and workspace plugins. Since 1.1.
   */
  readonly cwd?: string;
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

/**
 * True for the marker, alone or with the address of the secret it stands
 * for as a JSON Pointer (`••••••#/keys/1`): a secret inside a list carries its place in the
 * section, so it stays the same secret when the list is reordered. Anything
 * else after `#` (`••••••#note`) is a value, never a marker (security.md D1706).
 */
export const isRedactedSecret = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === SECRET_REDACTED || value.startsWith(`${SECRET_REDACTED}#/`));

/**
 * `host.editors@1`, provided by `jhin.editors`: the editors installed on a node
 * and opening a project's file in one (docs/plans/source-control.md, D286).
 * Its commands are `editors.list` and `editors.open`.
 */
export const HOST_EDITORS_CAPABILITY = "host.editors";

/** How an editor takes a position: `--goto file:line:col`, `file:line:col` as is, or `--line N file`. */
export type EditorLaunchStyle = "direct-path" | "goto" | "line-column";

export interface EditorDefinition {
  readonly id: string;
  readonly label: string;
  /** The commands it is started with, in order of preference; none for the file manager. */
  readonly commands: readonly string[] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
}

// T3 Code's editor list (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/editor.ts.
export const EDITORS: readonly EditorDefinition[] = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    baseArgs: ["--classic"],
    launchStyle: "goto",
  },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  { id: "vscode", label: "VS Code", commands: ["code"], launchStyle: "goto" },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
  },
  { id: "vscodium", label: "VSCodium", commands: ["codium"], launchStyle: "goto" },
  { id: "zed", label: "Zed", commands: ["zed", "zeditor"], launchStyle: "direct-path" },
  {
    id: "antigravity",
    label: "Antigravity",
    commands: ["antigravity-ide", "agy-ide"],
    launchStyle: "goto",
  },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], launchStyle: "line-column" },
  { id: "aqua", label: "Aqua", commands: ["aqua"], launchStyle: "line-column" },
  { id: "clion", label: "CLion", commands: ["clion"], launchStyle: "line-column" },
  { id: "datagrip", label: "DataGrip", commands: ["datagrip"], launchStyle: "line-column" },
  { id: "dataspell", label: "DataSpell", commands: ["dataspell"], launchStyle: "line-column" },
  { id: "goland", label: "GoLand", commands: ["goland"], launchStyle: "line-column" },
  { id: "phpstorm", label: "PhpStorm", commands: ["phpstorm"], launchStyle: "line-column" },
  { id: "pycharm", label: "PyCharm", commands: ["pycharm"], launchStyle: "line-column" },
  { id: "rider", label: "Rider", commands: ["rider"], launchStyle: "line-column" },
  { id: "rubymine", label: "RubyMine", commands: ["rubymine"], launchStyle: "line-column" },
  { id: "rustrover", label: "RustRover", commands: ["rustrover"], launchStyle: "line-column" },
  { id: "webstorm", label: "WebStorm", commands: ["webstorm"], launchStyle: "line-column" },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
];

/** An editor found on a node (`editors.list`). */
export interface EditorInfo {
  readonly id: string;
  readonly label: string;
}

/**
 * What a node's file manager is, for T3's "Reveal in …" wording (D922):
 * Finder on macOS, File Explorer on Windows, the desktop's Files elsewhere.
 */
export type FileManagerRevealKind = "finder" | "file-explorer" | "files";

/** Error codes of `editors.open`. */
export type EditorErrorCode =
  | "PROJECT_NOT_FOUND"
  /** Since D1644: the `threadId` given is not a thread of the project. */
  | "THREAD_NOT_FOUND"
  | "PATH_OUTSIDE_PROJECT"
  | "EDITOR_NOT_FOUND"
  /** A Windows `.cmd` launcher cannot take the path safely (`"`, `%`, `&`, …). */
  | "PATH_UNSAFE"
  | "LAUNCH_FAILED";

export * from "./config-change.ts";
export * from "./config-read.ts";
