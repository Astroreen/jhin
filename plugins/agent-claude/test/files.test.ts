import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { claudeConfigDir } from "../src/files.ts";

const saved = process.env["CLAUDE_CONFIG_DIR"];
afterEach(() => {
  if (saved === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = saved;
});

describe("jhin.agent-claude: Claude Code's config directory (D345)", () => {
  it("is the config's, else the node's when the allow-list passes it, else ~/.claude", () => {
    process.env["CLAUDE_CONFIG_DIR"] = "/node/claude";
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/config/claude" }, ["PATH"])).toBe(
      "/config/claude",
    );
    expect(claudeConfigDir({}, ["*"])).toBe("/node/claude");
    expect(claudeConfigDir({}, ["CLAUDE_*"])).toBe("/node/claude");
    // Withheld from Claude Code: it uses its default, and so does the cleanup.
    expect(claudeConfigDir({}, ["PATH"])).toBe(Path.join(Os.homedir(), ".claude"));
  });
});
