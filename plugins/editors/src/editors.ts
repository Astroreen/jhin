// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/shared/src/editor.ts (finding an
// editor's command) and apps/server/src/process/externalLauncher.ts (its arguments, the file manager).
import * as Fs from "node:fs";
import * as Path from "node:path";

import type { EditorDefinition } from "@jhin/host-api";

/** What to start: a program and its arguments. */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  /** The arguments reach the program as written (a `cmd.exe /s /c` line, quoted here). */
  readonly verbatim?: boolean;
}

/** A file and, optionally, where in it. */
export interface Target {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** What finding an editor may look at; the real process's by default. */
export interface Host {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  isExecutable(path: string): boolean;
  readDirectory(path: string): readonly string[];
}

export const nodeHost: Host = {
  platform: process.platform,
  env: process.env,
  isExecutable: (path) => {
    try {
      Fs.accessSync(path, Fs.constants.X_OK);
      return Fs.statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readDirectory: (path) => {
    try {
      return Fs.readdirSync(path);
    } catch {
      return [];
    }
  },
};

/**
 * Where a command on `PATH` (with Windows' extensions), or an absolute path,
 * can run from: its name as given, except on Windows, where the file found
 * (`code.cmd`) says how it has to be started.
 */
function resolveCommand(command: string, host: Host): string | undefined {
  const windows = host.platform === "win32";
  const pathModule = windows ? Path.win32 : Path.posix;
  const extensions = windows
    ? ["", ...(host.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  const found = (candidate: string) => (windows ? candidate : command);
  if (pathModule.isAbsolute(command)) {
    for (const extension of extensions) {
      if (host.isExecutable(command + extension)) return found(command + extension);
    }
    return undefined;
  }
  const path = host.env["PATH"] ?? host.env["Path"] ?? "";
  for (const directory of path.split(pathModule.delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = pathModule.join(directory, command + extension);
      if (host.isExecutable(candidate)) return found(candidate);
    }
  }
  return undefined;
}

const INSTALL_NAMES: Readonly<Record<string, readonly string[]>> = {
  vscode: ["Visual Studio Code"],
  "vscode-insiders": ["Visual Studio Code - Insiders"],
  antigravity: ["Antigravity IDE"],
  idea: ["IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Ultimate"],
  pycharm: ["PyCharm", "PyCharm CE"],
  rider: ["Rider", "JetBrains Rider"],
};

/** `<name> <version>.app`, so stable VS Code never resolves to `… - Insiders.app`. */
const isVersionedBundle = (entry: string, name: string) => {
  if (!entry.startsWith(`${name} `) || !entry.endsWith(".app")) return false;
  return /^\d[\d.]*$/.test(entry.slice(name.length + 1, -".app".length));
};

/**
 * How to start an editor: its command on `PATH`, else where its installer
 * usually puts it (macOS bundles, Windows program folders, Linux bin folders,
 * JetBrains Toolbox scripts). None when it is not installed.
 */
export function findEditorCommand(
  editor: EditorDefinition,
  host: Host = nodeHost,
): { command: string; baseArgs: readonly string[] } | undefined {
  if (editor.commands === null || editor.commands.length === 0) return undefined;
  const baseArgs = editor.baseArgs ?? [];
  const { platform, env } = host;
  // OpenZFS also installs a `zed`: on macOS the editor's bundle comes first.
  const preferBundle = platform === "darwin" && editor.id === "zed";
  if (!preferBundle) {
    for (const command of editor.commands) {
      const resolved = resolveCommand(command, host);
      if (resolved !== undefined) return { command: resolved, baseArgs };
    }
  }
  const path = platform === "win32" ? Path.win32 : Path.posix;
  const home = env["HOME"];
  const names = INSTALL_NAMES[editor.id] ?? [editor.label];
  const command = editor.commands[0]!;
  const jetbrains = editor.launchStyle === "line-column";
  const candidates: string[] = [];
  if (platform === "darwin") {
    for (const root of [...(home ? [path.join(home, "Applications")] : []), "/Applications"]) {
      const bundles = new Set(names.map((name) => `${name}.app`));
      for (const entry of host.readDirectory(root)) {
        if (names.some((name) => entry === `${name}.app` || isVersionedBundle(entry, name))) {
          bundles.add(entry);
        }
      }
      for (const bundle of bundles) {
        const contents = path.join(root, bundle, "Contents");
        candidates.push(
          ...(jetbrains || editor.id === "zed"
            ? [path.join(contents, "MacOS", editor.id === "zed" ? "cli" : command)]
            : [
                path.join(contents, "Resources/app/bin", command),
                path.join(contents, "Resources/app/bin/code"),
              ]),
        );
      }
    }
    if (home && jetbrains) {
      candidates.push(
        path.join(home, "Library/Application Support/JetBrains/Toolbox/scripts", command),
      );
    }
  } else if (platform === "win32") {
    const roots = [
      ...(env["LOCALAPPDATA"] ? [path.join(env["LOCALAPPDATA"], "Programs")] : []),
      ...[env["ProgramFiles"], env["ProgramFiles(x86)"], env["ProgramW6432"]].filter(
        (root): root is string => !!root,
      ),
    ];
    if (jetbrains) {
      if (env["LOCALAPPDATA"]) {
        candidates.push(
          path.join(env["LOCALAPPDATA"], "JetBrains/Toolbox/scripts", `${command}.cmd`),
        );
      }
      for (const directory of roots.flatMap((root) => [root, path.join(root, "JetBrains")])) {
        for (const entry of host.readDirectory(directory)) {
          if (names.some((name) => entry === name || entry.startsWith(`${name} `))) {
            candidates.push(path.join(directory, entry, "bin", `${command}64.exe`));
            candidates.push(path.join(directory, entry, "bin", `${command}.exe`));
          }
        }
      }
    } else {
      const name =
        editor.id === "vscode"
          ? "Microsoft VS Code"
          : editor.id === "vscode-insiders"
            ? "Microsoft VS Code Insiders"
            : editor.label;
      for (const root of roots) {
        candidates.push(
          path.join(root, name, "resources/app/bin", `${command}.cmd`),
          path.join(root, name, "resources/app/bin/code.cmd"),
          path.join(root, name, "bin", `${command}.cmd`),
          path.join(root, name, "bin/code.cmd"),
        );
        if (editor.id === "zed") {
          candidates.push(
            path.join(root, name, "bin", "zed.exe"),
            path.join(root, name, "zed.exe"),
          );
        }
      }
    }
  } else {
    const directories = [
      ...(home ? [path.join(home, ".local/bin")] : []),
      "/usr/local/bin",
      "/usr/bin",
      "/snap/bin",
    ];
    if (jetbrains) {
      const dataHome = env["XDG_DATA_HOME"] || (home ? path.join(home, ".local/share") : undefined);
      if (dataHome) directories.push(path.join(dataHome, "JetBrains/Toolbox/scripts"));
    }
    for (const directory of directories) {
      for (const name of editor.commands) candidates.push(path.join(directory, name));
    }
  }
  if (preferBundle) candidates.push(...editor.commands);
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate, host);
    if (resolved !== undefined) {
      return {
        command: resolved,
        baseArgs:
          editor.id === "kiro" && (platform === "darwin" || platform === "win32") ? [] : baseArgs,
      };
    }
  }
  return undefined;
}

/** The program that opens a file with its default application, if the node has one. */
export function fileManagerCommand(host: Host = nodeHost): string | undefined {
  switch (host.platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default: {
      const graphical = [host.env["DISPLAY"], host.env["WAYLAND_DISPLAY"]].some(
        (value) => value !== undefined && value.trim().length > 0,
      );
      return graphical && resolveCommand("xdg-open", host) !== undefined ? "xdg-open" : undefined;
    }
  }
}

/** An editor's arguments for a target, in its launch style. */
export function editorArgs(editor: EditorDefinition, target: Target): string[] {
  const position =
    target.line === undefined
      ? target.path
      : `${target.path}:${target.line}${target.column === undefined ? "" : `:${target.column}`}`;
  switch (editor.launchStyle) {
    case "direct-path":
      return [position];
    case "goto":
      return target.line === undefined ? [target.path] : ["--goto", position];
    case "line-column":
      return target.line === undefined
        ? [target.path]
        : [
            "--line",
            String(target.line),
            ...(target.column === undefined ? [] : ["--column", String(target.column)]),
            target.path,
          ];
  }
}

/**
 * A project-relative path inside the project's folder, as an absolute path;
 * none for an absolute path, `..` that leaves the folder, an empty one, or a
 * symbolic link (on the way or at the end) that leads out of the folder.
 */
export function resolveInProject(projectPath: string, relative: string): string | undefined {
  if (relative.trim() === "" || Path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    return undefined;
  }
  const root = Path.resolve(projectPath);
  const resolved = Path.resolve(root, relative.replaceAll("\\", "/"));
  if (!isInside(root, resolved)) return undefined;
  // Links are followed: what opens is where they lead. A file that does not exist (yet) is
  // checked as written.
  if (!isInside(realpathOr(root), realpathOr(resolved))) return undefined;
  return resolved;
}

function isInside(root: string, path: string): boolean {
  const inside = Path.relative(root, path);
  return (
    inside !== "" &&
    inside !== ".." &&
    !inside.startsWith(`..${Path.sep}`) &&
    !Path.isAbsolute(inside)
  );
}

/**
 * Where a path leads: its deepest existing ancestor resolved, with the rest
 * appended, so a link that dangles or a file not written yet is judged by
 * where its existing part leads.
 */
function realpathOr(path: string, depth = 0): string {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return Path.join(Fs.realpathSync(existing), ...rest);
    } catch {
      // A link whose target is missing still leads somewhere: follow it.
      const link = readlinkOr(existing);
      if (link !== undefined && depth < 40) {
        return Path.join(
          realpathOr(Path.resolve(Path.dirname(existing), link), depth + 1),
          ...rest,
        );
      }
      const parent = Path.dirname(existing);
      if (parent === existing) return path;
      rest.unshift(Path.basename(existing));
      existing = parent;
    }
  }
}

function readlinkOr(path: string): string | undefined {
  try {
    return Fs.readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Characters `cmd.exe` reads as syntax even inside quotes: a path holding one is refused. */
const CMD_UNSAFE = /["%&|^<>!\r\n]/;

/**
 * How to start a `.cmd`/`.bat` launcher, which only runs through `cmd.exe`:
 * `cmd.exe /d /s /c ""<launcher>" "<arg>" …"` with every part quoted and the
 * line passed as written, so neither a space in `C:\\Program Files` nor a
 * file's name is read as syntax. None when a part holds a character `cmd.exe`
 * reads even inside quotes.
 */
export function cmdLaunch(command: string, args: readonly string[]): Launch | undefined {
  const parts = [command, ...args];
  if (parts.some((part) => CMD_UNSAFE.test(part))) return undefined;
  const line = parts.map((part) => `"${part}"`).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** A launcher Windows only starts through `cmd.exe`. */
export const needsCmd = (platform: NodeJS.Platform, command: string) =>
  platform === "win32" && /\.(cmd|bat)$/i.test(command);
