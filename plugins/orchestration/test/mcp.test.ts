import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { PluginDefinition } from "@jhin/sdk";
import {
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  type TestKernel,
} from "@jhin/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// The SDK's transport types disagree under exactOptionalPropertyTypes; the objects match.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it } from "vite-plus/test";

import agent from "../../agent-fake/src/index.ts";
import auth from "../../auth-token/src/index.ts";
import http from "../../http/src/index.ts";
import mcp from "../../mcp-server/src/index.ts";
import threads from "../../threads/src/index.ts";
import { orchestrationPlugin } from "./support.ts";

const real = (dir: string, definition: PluginDefinition) => ({
  manifest: JSON.parse(
    Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8"),
  ).jhin,
  definition,
});

let kernel: TestKernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
});

it("is reachable as MCP tools that act as the calling thread", async () => {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-orchestration-mcp-"));
  kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      memoryStoragePlugin(),
      real("http", http),
      real("auth-token", auth),
      real("threads", threads),
      real("agent-fake", agent),
      real("mcp-server", mcp),
      orchestrationPlugin,
    ],
    config: { node: { "jhin.http": { port: 0 } } },
  });
  const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
  const { token } = (await kernel.commands.execute("auth.token.show", {})) as { token: string };
  const parent = (await kernel.commands.execute("threads.create", { title: "Parent" })) as {
    id: string;
  };

  const client = new Client({ name: "jhin-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, "x-jhin-thread": parent.id } },
    }) as unknown as Transport,
  );
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "orchestration_capabilities",
      "orchestration_launch",
      "tasks_delegate",
      "tasks_status",
      "tasks_cancel",
      "tasks_list",
      "workflows_run",
      "workflows_status",
      "workflows_stop",
      "workflows_list",
    ]),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
  };
  const task = await call("tasks_delegate", { task: "over mcp", mode: "wait" });
  expect(task).toMatchObject({
    parentThreadId: parent.id,
    status: "completed",
    summary: "Echo: over mcp",
  });
  expect(await call("tasks_status", { taskId: task.taskId })).toMatchObject({
    summary: "Echo: over mcp",
  });
  expect(await call("orchestration_capabilities", {})).toMatchObject({ parentThreadId: parent.id });
  await client.close();
});
