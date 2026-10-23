import { describe, expect, it, vi } from "vite-plus/test";

import {
  MCP_APP_PROTOCOL_VERSION,
  clampMcpAppHeight,
  makeMcpAppHost,
  mcpAppAllowAttribute,
  normalizeMcpAppToolResult,
  type McpAppHostOptions,
} from "../src/lib/mcp-app-host.ts";

/** A host whose posts are kept, with the given calls. */
function host(overrides: Partial<McpAppHostOptions> = {}) {
  const posted: Record<string, unknown>[] = [];
  const sizes: unknown[] = [];
  /** Who waits for the answer to which request. */
  const waiting = new Map<unknown, (message: Record<string, unknown>) => void>();
  const instance = makeMcpAppHost({
    app: {
      server: "board",
      tool: "show",
      resourceUri: "ui://board",
      documentId: "d",
      permissions: ["clipboardWrite"],
    },
    hostVersion: "jhin",
    post: (message) => {
      const record = message as Record<string, unknown>;
      posted.push(record);
      waiting.get(record["id"])?.(record);
    },
    hostContext: () => ({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: 600, maxHeight: 2000 },
      platform: "web",
    }),
    callTool: async ({ name, arguments: args }) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      _meta: null,
    }),
    readResource: async () => ({ contents: [] }),
    openLink: async () => undefined,
    sendMessage: async () => undefined,
    onRequestTeardown: () => undefined,
    onSizeChanged: (size) => sizes.push(size),
    ...overrides,
  });
  /** Settles once the host answered request `id`. */
  const answer = (id: number) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const found = posted.find((message) => message["id"] === id);
      if (found !== undefined) resolve(found);
      else waiting.set(id, resolve);
    });
  return { instance, posted, sizes, answer };
}

describe("an MCP app's host bridge (D1403)", () => {
  it("initializes, then sends the call's input and result", () => {
    const { instance, posted } = host();
    instance.setToolCall({ arguments: { project: "jhin" }, result: { content: [], _meta: null } });
    instance.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: MCP_APP_PROTOCOL_VERSION },
    });
    expect(posted[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        hostInfo: { name: "jhin" },
        hostCapabilities: { sandbox: { permissions: { clipboardWrite: {} } } },
        hostContext: { theme: "dark" },
      },
    });
    // Nothing more until the app says it is initialized.
    expect(posted).toHaveLength(1);
    instance.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(posted.slice(1).map((message) => message["method"])).toEqual([
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
    ]);
    // Codex's `_meta: null` is dropped, as the SDK rejects it.
    expect(posted[2]!["params"]).toEqual({ content: [] });
  });

  it("calls tools, refuses malformed and oversized requests and unknown methods", async () => {
    const { instance, answer } = host();
    instance.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "move", arguments: { card: 1 } },
    });
    expect(await answer(2)).toMatchObject({
      result: { content: [{ type: "text", text: 'move:{"card":1}' }] },
    });
    instance.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: [] } });
    expect(await answer(3)).toMatchObject({ error: { code: -32602 } });
    instance.receive({ jsonrpc: "2.0", id: 4, method: "ui/download-file", params: {} });
    expect(await answer(4)).toMatchObject({ error: { code: -32601 } });
    instance.receive({
      jsonrpc: "2.0",
      id: 5,
      method: "ping",
      params: { padding: "x".repeat(300 * 1024) },
    });
    expect(await answer(5)).toMatchObject({
      error: { code: -32600, message: "Message too large." },
    });
    instance.receive({
      jsonrpc: "2.0",
      id: 6,
      method: "ui/open-link",
      params: { url: "file:///etc" },
    });
    expect(await answer(6)).toMatchObject({ error: { code: -32602 } });
  });

  it("says why a call failed, and takes sizes and text messages from the user role", async () => {
    const sent: string[] = [];
    const { instance, answer, sizes } = host({
      callTool: async () => {
        throw new Error("Declined by the user.");
      },
      sendMessage: async (text) => void sent.push(text),
    });
    instance.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } });
    expect(await answer(7)).toMatchObject({ error: { message: "Declined by the user." } });
    instance.receive({
      jsonrpc: "2.0",
      id: 8,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "Move it" }] },
    });
    await answer(8);
    expect(sent).toEqual(["Move it"]);
    instance.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 9000 },
    });
    expect(sizes).toEqual([{ height: 9000 }]);
    expect(clampMcpAppHeight(9000)).toBe(2000);
    expect(clampMcpAppHeight(10)).toBe(80);
  });

  it("refuses a 17th request in flight, and takes requests again once they settle", async () => {
    const release: (() => void)[] = [];
    const { instance, answer } = host({
      callTool: () =>
        new Promise((resolve) => release.push(() => resolve({ content: [], _meta: null }))),
    });
    for (let id = 1; id <= 17; id++) {
      instance.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "x" } });
    }
    expect(await answer(17)).toMatchObject({
      error: { code: -32000, message: "Too many requests in flight." },
    });
    for (const done of release) done();
    expect(await answer(16)).toMatchObject({ result: { content: [] } });
    instance.receive({ jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "x" } });
    release.at(-1)!();
    expect(await answer(18)).toMatchObject({ result: { content: [] } });
  });

  it("tells an initialized app what changed, and asks it to wrap up before it goes", async () => {
    let theme: "dark" | "light" = "dark";
    const posted: Record<string, unknown>[] = [];
    const { instance } = host({
      post: (message) => posted.push(message as Record<string, unknown>),
      hostContext: () => ({
        theme,
        styles: { variables: {} },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { width: 600, maxHeight: 2000 },
        platform: "web",
      }),
    });
    // Before it initialized, the app gets nothing: it reads the context from its answer.
    theme = "light";
    instance.updateHostContext();
    expect(posted).toHaveLength(0);
    instance.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    instance.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    theme = "dark";
    instance.updateHostContext();
    expect(posted.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark" },
    });
    // Only inline here.
    instance.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    expect(posted.at(-1)).toMatchObject({ id: 2, result: { mode: "inline" } });
    // Teardown waits for the app's answer, then the host sends nothing more.
    const gone = instance.teardown();
    const request = posted.at(-1)!;
    expect(request).toMatchObject({ method: "ui/resource-teardown" });
    instance.receive({ jsonrpc: "2.0", id: request["id"], result: {} });
    await gone;
    const count = posted.length;
    instance.receive({ jsonrpc: "2.0", id: 3, method: "ping", params: {} });
    expect(posted).toHaveLength(count);
  });

  it("goes after two seconds when the app does not answer its teardown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { instance, posted } = host();
      instance.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
      instance.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      let gone = false;
      const teardown = instance.teardown().then(() => (gone = true));
      expect(posted.at(-1)).toMatchObject({ method: "ui/resource-teardown" });
      vi.advanceTimersByTime(1999);
      await Promise.resolve();
      expect(gone).toBe(false);
      vi.advanceTimersByTime(1);
      await teardown;
      expect(gone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the frame's features and keeps results the SDK takes", () => {
    expect(mcpAppAllowAttribute(["camera", "clipboardWrite"])).toBe("camera; clipboard-write");
    expect(normalizeMcpAppToolResult({ content: "x" as never, isError: false })).toEqual({
      content: [],
    });
  });
});
