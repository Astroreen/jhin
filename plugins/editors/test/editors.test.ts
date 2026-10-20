import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { EDITORS } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { createTestKernel, testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
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

  it("keeps paths inside the project's folder", () => {
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

  async function start(files: readonly string[], env: NodeJS.ProcessEnv = { PATH: "/opt/bin" }) {
    const launches: Launch[] = [];
    const kernel = await createTestKernel({
      plugins: [
        projects,
        {
          manifest,
          definition: createEditorsPlugin({
            host: fakeHost("linux", env, files),
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

  it("starts a real program detached", async () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-editors-"));
    dirs.push(dir);
    await launchDetached({ command: "/bin/sh", args: ["-c", "exit 0"] });
    await expect(
      launchDetached({ command: Path.join(dir, "missing"), args: [] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
