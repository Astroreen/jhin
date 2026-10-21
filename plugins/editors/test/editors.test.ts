import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { EDITORS } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { createTestKernel, testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cmdArgs,
  editorArgs,
  fileManagerCommand,
  findEditorCommand,
  resolveInProject,
  type Host,
  type Launch,
} from "../src/editors.ts";
import { createEditorsPlugin, launchDetached } from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;
const editor = (id: string) => EDITORS.find((candidate) => candidate.id === id)!;

/** A host whose executables are exactly `files`. */
const fakeHost = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  files: readonly string[],
  directories: Record<string, readonly string[]> = {},
): Host => ({
  platform,
  env,
  isExecutable: (path) => files.includes(path),
  readDirectory: (path) => directories[path] ?? [],
});

describe("finding and starting editors as T3 does", () => {
  it("builds each launch style's arguments", () => {
    const at = { path: "/p/src/a.ts", line: 12, column: 3 };
    expect(editorArgs(editor("vscode"), at)).toEqual(["--goto", "/p/src/a.ts:12:3"]);
    expect(editorArgs(editor("vscode"), { path: "/p/a.ts" })).toEqual(["/p/a.ts"]);
    expect(editorArgs(editor("zed"), at)).toEqual(["/p/src/a.ts:12:3"]);
    expect(editorArgs(editor("idea"), at)).toEqual([
      "--line",
      "12",
      "--column",
      "3",
      "/p/src/a.ts",
    ]);
    expect(editorArgs(editor("idea"), { path: "/p/a.ts", line: 4 })).toEqual([
      "--line",
      "4",
      "/p/a.ts",
    ]);
  });

  it("looks on PATH first, then in the usual install folders", () => {
    const linux = fakeHost("linux", { PATH: "/opt/bin", HOME: "/home/u" }, [
      "/opt/bin/cursor",
      "/home/u/.local/share/JetBrains/Toolbox/scripts/webstorm",
    ]);
    expect(findEditorCommand(editor("cursor"), linux)).toEqual({
      command: "cursor",
      baseArgs: ["--classic"],
    });
    expect(findEditorCommand(editor("webstorm"), linux)?.command).toBe(
      "/home/u/.local/share/JetBrains/Toolbox/scripts/webstorm",
    );
    expect(findEditorCommand(editor("vscode"), linux)).toBeUndefined();
    expect(findEditorCommand(editor("file-manager"), linux)).toBeUndefined();

    // A versioned macOS bundle, never the Insiders one for stable VS Code.
    const mac = fakeHost(
      "darwin",
      { PATH: "", HOME: "/Users/u" },
      [
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
        "/Applications/IntelliJ IDEA 2026.1.4.app/Contents/MacOS/idea",
      ],
      { "/Applications": ["Visual Studio Code - Insiders.app", "IntelliJ IDEA 2026.1.4.app"] },
    );
    expect(findEditorCommand(editor("vscode"), mac)).toBeUndefined();
    expect(findEditorCommand(editor("idea"), mac)?.command).toBe(
      "/Applications/IntelliJ IDEA 2026.1.4.app/Contents/MacOS/idea",
    );
  });

  it("opens files with the desktop's default application only in a graphical session", () => {
    const xdg = ["/usr/bin/xdg-open"];
    expect(fileManagerCommand(fakeHost("linux", { PATH: "/usr/bin" }, xdg))).toBeUndefined();
    expect(fileManagerCommand(fakeHost("linux", { PATH: "/usr/bin", DISPLAY: ":0" }, xdg))).toBe(
      "xdg-open",
    );
    expect(fileManagerCommand(fakeHost("darwin", {}, []))).toBe("open");
  });

  it("quotes a Windows launcher's arguments and refuses what cmd.exe would run", () => {
    expect(cmdArgs(["--goto", "C:\\p\\a b.ts:3"])).toEqual(['"--goto"', '"C:\\p\\a b.ts:3"']);
    for (const hostile of [
      "a&calc.ts",
      "x&&evil.ts",
      'q"uote.ts',
      "%PATH%.ts",
      "a|b.ts",
      "a^b.ts",
    ]) {
      expect(cmdArgs([`C:\\p\\${hostile}`])).toBeUndefined();
    }
  });

  it("keeps paths inside the project's folder, following links", () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-project-"));
    const outside = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-outside-"));
    try {
      Fs.writeFileSync(Path.join(outside, "secret"), "x");
      Fs.symlinkSync(outside, Path.join(root, "link"));
      Fs.mkdirSync(Path.join(root, "src"));
      Fs.symlinkSync(Path.join(root, "src"), Path.join(root, "alias"));
      expect(resolveInProject(root, "link/secret")).toBeUndefined();
      expect(resolveInProject(root, "alias/a.ts")).toBe(Path.join(root, "alias/a.ts"));
    } finally {
      Fs.rmSync(root, { recursive: true, force: true });
      Fs.rmSync(outside, { recursive: true, force: true });
    }
    expect(resolveInProject("/p", "..foo/x.ts")).toBe("/p/..foo/x.ts");
    expect(resolveInProject("/p", "src/a.ts")).toBe("/p/src/a.ts");
    expect(resolveInProject("/p", "./src/../b.ts")).toBe("/p/b.ts");
    expect(resolveInProject("/p", "../etc/passwd")).toBeUndefined();
    expect(resolveInProject("/p", "/etc/passwd")).toBeUndefined();
    expect(resolveInProject("/p", ".")).toBeUndefined();
  });
});

describe("the editors plugin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) Fs.rmSync(dir, { recursive: true, force: true });
  });

  const projects = {
    manifest: testManifest("test.projects"),
    definition: definePlugin({
      activate(context) {
        context.commands.register({
          name: "projects.list",
          description: "Projects",
          input: z.object({}),
          output: z.array(z.object({ id: z.string(), path: z.string() })),
          handler: () => [{ id: "app", path: "/work/app" }],
        });
      },
    }),
  };

  async function start(
    files: readonly string[],
    env: NodeJS.ProcessEnv = { PATH: "/opt/bin" },
    options: { platform?: NodeJS.Platform; projects?: boolean } = {},
  ) {
    const launches: Launch[] = [];
    const kernel = await createTestKernel({
      plugins: [
        ...(options.projects === false ? [] : [projects]),
        {
          manifest,
          definition: createEditorsPlugin({
            host: fakeHost(options.platform ?? "linux", env, files),
            launch: async (launch) => {
              if (launch.command === "zed") throw new Error("spawn EACCES");
              launches.push(launch);
            },
          }),
        },
      ],
    });
    return { kernel, launches };
  }

  it("lists the editors found, in T3's order, and opens a project's file at a line", async () => {
    const { kernel, launches } = await start(["/opt/bin/zed", "/opt/bin/code"]);
    expect(await kernel.commands.execute("editors.list", {})).toEqual({
      editors: [
        { id: "vscode", label: "VS Code" },
        { id: "zed", label: "Zed" },
      ],
    });
    expect(
      await kernel.commands.execute("editors.open", {
        projectId: "app",
        path: "src/a.ts",
        line: 7,
        editor: "vscode",
      }),
    ).toEqual({ editor: "vscode", path: "/work/app/src/a.ts" });
    expect(launches).toEqual([{ command: "code", args: ["--goto", "/work/app/src/a.ts:7"] }]);
    await kernel.stop();
  });

  it("refuses an unknown project, a path outside it, a missing editor and a failed start", async () => {
    const { kernel } = await start(["/opt/bin/code", "/opt/bin/broken/zed"], {
      PATH: "/opt/bin:/opt/bin/broken",
    });
    const open = (input: Record<string, unknown>) =>
      kernel.commands.execute("editors.open", {
        projectId: "app",
        path: "a.ts",
        editor: "vscode",
        ...input,
      });
    await expect(open({ projectId: "nope" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(open({ path: "../secret" })).rejects.toMatchObject({
      code: "PATH_OUTSIDE_PROJECT",
    });
    await expect(open({ editor: "rider" })).rejects.toMatchObject({
      code: "EDITOR_NOT_FOUND",
      message: "Rider is not installed on this node",
    });
    await expect(open({ editor: "file-manager" })).rejects.toMatchObject({
      code: "EDITOR_NOT_FOUND",
    });
    await expect(open({ editor: "zed" })).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    await kernel.stop();
  });

  it("opens the containing folder with the file manager, never the file itself", async () => {
    const { kernel, launches } = await start(["/usr/bin/xdg-open"], {
      PATH: "/usr/bin",
      DISPLAY: ":0",
    });
    await kernel.commands.execute("editors.open", {
      projectId: "app",
      path: "bin/run.desktop",
      editor: "file-manager",
    });
    expect(launches).toEqual([{ command: "xdg-open", args: ["/work/app/bin"] }]);
    await kernel.stop();
  });

  it("quotes a Windows .cmd launcher's arguments and refuses a hostile name", async () => {
    const { kernel, launches } = await start(
      ["C:\\bin\\code.cmd"],
      { PATH: "C:\\bin", PATHEXT: ".EXE;.cmd" },
      { platform: "win32" },
    );
    await kernel.commands.execute("editors.open", {
      projectId: "app",
      path: "src/a b.ts",
      line: 2,
      editor: "vscode",
    });
    expect(launches).toEqual([
      { command: "C:\\bin\\code.cmd", args: ['"--goto"', '"/work/app/src/a b.ts:2"'] },
    ]);
    await expect(
      kernel.commands.execute("editors.open", {
        projectId: "app",
        path: "a&calc.ts",
        editor: "vscode",
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await kernel.stop();
  });

  it("finds no project when the node has no projects plugin", async () => {
    const { kernel } = await start(["/opt/bin/code"], { PATH: "/opt/bin" }, { projects: false });
    await expect(
      kernel.commands.execute("editors.open", { projectId: "app", path: "a.ts", editor: "vscode" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await kernel.stop();
  });

  it("starts a real program detached", async () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-editors-"));
    dirs.push(dir);
    await launchDetached({ command: "/bin/sh", args: ["-c", "exit 0"] });
    await expect(
      launchDetached({ command: Path.join(dir, "missing"), args: [] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
