import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { EDITORS } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { createTestKernel, testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cmdLaunch,
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

  it("starts a Windows launcher as one quoted cmd.exe line, and refuses what cmd.exe would run", () => {
    expect(
      cmdLaunch("C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd", [
        "--goto",
        "C:\\p\\a b.ts:3",
      ]),
    ).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" "--goto" "C:\\p\\a b.ts:3""',
      ],
      verbatim: true,
    });
    for (const hostile of [
      "a&calc.ts",
      "x&&evil.ts",
      'q"uote.ts',
      "%PATH%.ts",
      "a|b.ts",
      "a^b.ts",
    ]) {
      expect(cmdLaunch("C:\\bin\\code.cmd", [`C:\\p\\${hostile}`])).toBeUndefined();
    }
    expect(cmdLaunch("C:\\Users\\A&B\\code.cmd", ["a.ts"])).toBeUndefined();
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
      // A link that dangles is judged by where it points.
      Fs.symlinkSync(Path.join(outside, "missing"), Path.join(root, "dangling"));
      expect(resolveInProject(root, "dangling")).toBeUndefined();
      expect(resolveInProject(root, "link/new/file.ts")).toBeUndefined();
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
        const threads: Record<string, { projectId: string; worktreePath?: string }> = {
          t1: { projectId: "app", worktreePath: "/work/trees/t1" },
          t2: { projectId: "app" },
          other: { projectId: "elsewhere", worktreePath: "/work/trees/other" },
        };
        context.commands.register({
          name: "threads.get",
          description: "A thread",
          input: z.object({ threadId: z.string() }),
          output: z.object({
            thread: z.object({ projectId: z.string(), worktreePath: z.string().optional() }),
          }),
          handler: ({ threadId }) => {
            if (threadId === "broken") throw new Error("storage unreadable");
            const thread = threads[threadId];
            if (thread === undefined) {
              throw Object.assign(new Error(`No thread ${threadId}`), { code: "THREAD_NOT_FOUND" });
            }
            return { thread };
          },
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

  it("opens a file of a thread's worktree, else of its project (D1644)", async () => {
    const { kernel, launches } = await start(["/opt/bin/code"]);
    const open = (threadId: string, path = "src/a.ts") =>
      kernel.commands.execute("editors.open", {
        projectId: "app",
        threadId,
        path,
        editor: "vscode",
      });
    expect(await open("t1")).toEqual({ editor: "vscode", path: "/work/trees/t1/src/a.ts" });
    expect(await open("t2")).toEqual({ editor: "vscode", path: "/work/app/src/a.ts" });
    await expect(open("other")).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    await expect(open("missing")).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    // Any other failure of reading the thread is that failure, not a missing thread.
    await expect(open("broken")).rejects.toThrow("storage unreadable");
    await expect(open("t1", "../../app/secret")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_PROJECT",
    });
    expect(launches).toEqual([
      { command: "code", args: ["/work/trees/t1/src/a.ts"] },
      { command: "code", args: ["/work/app/src/a.ts"] },
    ]);
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

  it("reveals a file selected in Finder and File Explorer, its folder on Linux (D922)", async () => {
    const reveal = { projectId: "app", path: "bin/run.sh", editor: "file-manager", reveal: true };
    const mac = await start([], { PATH: "/usr/bin" }, { platform: "darwin" });
    expect(await mac.kernel.commands.execute("editors.list", {})).toMatchObject({
      revealKind: "finder",
    });
    await mac.kernel.commands.execute("editors.open", reveal);
    expect(mac.launches).toEqual([{ command: "open", args: ["-R", "/work/app/bin/run.sh"] }]);
    await mac.kernel.stop();

    const windows = await start([], { PATH: "C:\\bin" }, { platform: "win32" });
    expect(await windows.kernel.commands.execute("editors.list", {})).toMatchObject({
      revealKind: "file-explorer",
    });
    await windows.kernel.commands.execute("editors.open", reveal);
    expect(windows.launches).toEqual([
      // Backslashes, or Explorer selects nothing.
      { command: "explorer", args: ['/select,"\\work\\app\\bin\\run.sh"'], verbatim: true },
    ]);
    // Spaces and a comma stay inside the quotes Explorer reads the path from.
    await windows.kernel.commands.execute("editors.open", { ...reveal, path: "my dir/a,b c.ts" });
    expect(windows.launches.at(-1)).toEqual({
      command: "explorer",
      args: ['/select,"\\work\\app\\my dir\\a,b c.ts"'],
      verbatim: true,
    });
    // A `"` would close Explorer's quotes and pass the rest as its switches.
    await expect(
      windows.kernel.commands.execute("editors.open", { ...reveal, path: 'a" /root,C:\\.ts' }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await windows.kernel.stop();

    const linux = await start(["/usr/bin/xdg-open"], { PATH: "/usr/bin", DISPLAY: ":0" });
    expect(await linux.kernel.commands.execute("editors.list", {})).toMatchObject({
      revealKind: "files",
    });
    await linux.kernel.commands.execute("editors.open", reveal);
    expect(linux.launches).toEqual([{ command: "xdg-open", args: ["/work/app/bin"] }]);
    // An editor opens; only the file manager reveals.
    await expect(
      linux.kernel.commands.execute("editors.open", { ...reveal, editor: "vscode" }),
    ).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
      details: { issues: [{ path: "", message: "Only the file manager reveals a file" }] },
    });
    await linux.kernel.stop();

    // No file manager (no graphical session): nothing to reveal with.
    const headless = await start(["/usr/bin/xdg-open"], { PATH: "/usr/bin" });
    expect(await headless.kernel.commands.execute("editors.list", {})).toEqual({ editors: [] });
    await headless.kernel.stop();
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
      {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", '""C:\\bin\\code.cmd" "--goto" "/work/app/src/a b.ts:2""'],
        verbatim: true,
      },
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

  it("reports a failing projects plugin as it failed, not as a missing project", async () => {
    const failing = {
      manifest: testManifest("test.failing-projects"),
      definition: definePlugin({
        activate(context) {
          context.commands.register({
            name: "projects.list",
            description: "Projects",
            input: z.object({}),
            output: z.array(z.object({ id: z.string(), path: z.string() })),
            handler: () => {
              throw new Error("storage is gone");
            },
          });
        },
      }),
    };
    const kernel = await createTestKernel({
      plugins: [
        failing,
        {
          manifest,
          definition: createEditorsPlugin({
            host: fakeHost("linux", { PATH: "/opt/bin" }, ["/opt/bin/code"]),
            launch: async () => undefined,
          }),
        },
      ],
    });
    await expect(
      kernel.commands.execute("editors.open", { projectId: "app", path: "a.ts", editor: "vscode" }),
    ).rejects.toThrow("storage is gone");
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
