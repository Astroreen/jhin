import type { ProjectScript } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectScript,
  importableScripts,
  inputFromFile,
  scriptsWith,
  type ScriptInput,
} from "../src/plugins/project-scripts/control.tsx";

const input = (values: Partial<ScriptInput>): ScriptInput => ({
  name: "Dev",
  command: "pnpm dev",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  previewUrl: null,
  autoOpenPreview: false,
  ...values,
});

describe("the scripts menu's saving (source-control.md D1474)", () => {
  it("builds T3's script: a hold of the agent only for a setup script, a preview only with a URL", () => {
    expect(buildProjectScript("dev", input({ waitForSetup: true }))).toEqual({
      id: "dev",
      name: "Dev",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    });
    expect(
      buildProjectScript(
        "setup",
        input({
          runOnWorktreeCreate: true,
          waitForSetup: true,
          previewUrl: "http://localhost:5173",
          autoOpenPreview: true,
        }),
      ),
    ).toMatchObject({ async: false, previewUrl: "http://localhost:5173", autoOpenPreview: true });
  });

  it("gives a new script an id of its own and takes the setup role from the one that had it", () => {
    const setup: ProjectScript = {
      id: "install",
      name: "Install",
      command: "pnpm i",
      icon: "configure",
      runOnWorktreeCreate: true,
    };
    const saved = scriptsWith([setup], null, input({ name: "Install", runOnWorktreeCreate: true }));
    expect(saved.id).toBe("install-2");
    expect(saved.scripts.map((script) => [script.id, script.runOnWorktreeCreate])).toEqual([
      ["install", false],
      ["install-2", true],
    ]);
    expect(scriptsWith(saved.scripts, "install", input({ name: "Reinstall" })).scripts[0]).toEqual({
      id: "install",
      name: "Reinstall",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    });
  });

  it("offers a t3.json script once, by command or name", () => {
    const own: ProjectScript = {
      id: "dev",
      name: "Dev",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    };
    const file = [
      { name: "dev", command: "other" },
      { name: "Serve", command: "pnpm dev" },
      { name: "Lint", command: "pnpm lint", icon: "lint" as const, async: false },
    ];
    expect(importableScripts([own], file).map((entry) => entry.name)).toEqual(["Lint"]);
    expect(inputFromFile(file[2]!)).toMatchObject({ icon: "lint", waitForSetup: false });
  });
});
