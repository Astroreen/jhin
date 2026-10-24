import { z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_SETTINGS_META,
  commandForProjectScript,
  nextProjectScriptId,
  parseT3ProjectFile,
  primaryProjectScript,
  projectScriptMenuLabel,
  projectSettingsRecord,
  releaseClaimedRoles,
  resolveProjectSettings,
  type ProjectScript,
} from "../src/index.ts";

const script = (id: string, roles: Partial<ProjectScript> = {}): ProjectScript => ({
  id,
  name: id,
  command: `run ${id}`,
  icon: "play",
  runOnWorktreeCreate: false,
  ...roles,
});

describe("project settings (config-ui.md D1462)", () => {
  it("marks the record for the settings page and keeps its entries strict", () => {
    const record = projectSettingsRecord({ mode: z.enum(["a", "b"]).optional() });
    expect(z.toJSONSchema(record, { io: "input" })).toMatchObject({
      type: "object",
      [PROJECT_SETTINGS_META]: true,
    });
    expect(record.parse(undefined)).toEqual({});
    expect(record.safeParse({ p: { other: 1 } }).success).toBe(false);
  });

  it("lets a project's entry replace the keys it sets, whole, and nothing else", () => {
    const config = {
      mode: "a",
      rules: { x: 1, y: 2 },
      untouched: true,
      projects: { p: { rules: { x: 3 }, mode: undefined } } as Record<
        string,
        { mode?: string; rules?: { x: number; y?: number } }
      >,
    };
    expect(resolveProjectSettings(config, "p", ["mode", "rules"])).toEqual({
      ...config,
      rules: { x: 3 },
    });
    expect(resolveProjectSettings(config, "q", ["mode"])).toBe(config);
    expect(resolveProjectSettings(config, undefined, ["mode"])).toBe(config);
  });
});

describe("project scripts (source-control.md D1471, D1474, D1475)", () => {
  it("names a script's roles and picks the header's script as T3 does", () => {
    const setup = script("setup", { runOnWorktreeCreate: true, runOnSettle: true });
    expect(projectScriptMenuLabel(setup)).toBe("setup (setup, on settle)");
    expect(primaryProjectScript([setup, script("dev")])?.id).toBe("dev");
    expect(primaryProjectScript([script("s", { runOnSettle: true })])).toBeUndefined();
  });

  it("makes an id from the name that no other script has", () => {
    expect(nextProjectScriptId("Run Tests!", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run tests", ["run-tests", "run-tests-2"])).toBe("run-tests-3");
    expect(nextProjectScriptId("  ", [])).toBe("script");
    expect(nextProjectScriptId("a".repeat(40), ["a".repeat(24)])).toBe(`${"a".repeat(22)}-2`);
    expect(commandForProjectScript("run-tests")).toBe("script.run-tests.run");
    expect(commandForProjectScript("Bad Id")).toBeUndefined();
  });

  it("takes the setup and settle roles from the script that had them", () => {
    const old = script("old", { runOnWorktreeCreate: true, runOnSettle: true });
    expect(releaseClaimedRoles(old, { runOnWorktreeCreate: true, runOnSettle: false })).toEqual({
      ...old,
      runOnWorktreeCreate: false,
    });
    expect(releaseClaimedRoles(old, { runOnWorktreeCreate: false })).toBe(old);
  });
});

describe("the checked-in t3.json (source-control.md D1465)", () => {
  it("reads T3's lenient JSON: comments, trailing commas, a URL in a comment or a string", () => {
    expect(
      parseT3ProjectFile(
        [
          "/* see https://t3.codes/docs // not a line comment */",
          "{",
          '  "$schema": "https://t3.codes/schema/t3.json", // the schema',
          '  "scripts": [{ "name": "a /* b */ c", "command": "echo \\"//\\"", },],',
          "}",
        ].join("\n"),
      ),
    ).toEqual({
      file: {
        $schema: "https://t3.codes/schema/t3.json",
        scripts: [{ name: "a /* b */ c", command: 'echo "//"' }],
      },
    });
  });

  it("says why a file is none", () => {
    expect(parseT3ProjectFile("{ nope").error).toMatch(/^t3\.json is not JSON/);
    expect(parseT3ProjectFile('{ "worktreeSubmodules": "all" }').error).toMatch(
      /^t3\.json is not a T3 project file at worktreeSubmodules/,
    );
  });
});
