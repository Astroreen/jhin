import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// The SDK's transport types disagree under exactOptionalPropertyTypes; the objects match.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vite-plus/test";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

describe("jhin mcp", () => {
  it("serves every command as an MCP tool over stdio", async () => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-mcp-cli-"));
    Fs.mkdirSync(Path.join(home, ".jhin"));
    Fs.writeFileSync(
      Path.join(home, ".jhin", "config.jsonc"),
      '{ "jhin.http": { "port": 0 }, "jhin.threads": { "defaultAgent": "jhin.agent-fake" } }',
    );
    const client = new Client({ name: "jhin-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN, "mcp", "--home", home, "--cwd", home],
        stderr: "ignore",
      }) as unknown as Transport,
    );

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["example_greet", "threads_create", "threads_send", "host_inspect"]),
    );

    const greeting = await client.callTool({ name: "example_greet", arguments: { name: "Ada" } });
    expect(greeting.structuredContent).toEqual({ message: "Hello, Ada!", count: 1 });
    const thread = await client.callTool({
      name: "threads_create",
      arguments: { title: "From MCP" },
    });
    expect(thread.structuredContent).toMatchObject({ projectId: "scratch", title: "From MCP" });

    await client.close();
  });
});
