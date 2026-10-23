// The host side of an MCP app's bridge (providers.md D1403). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/client-runtime/src/mcpApps/host.ts
// (makeMcpAppHost, normalizeMcpAppToolResult, mcpAppStyleVariables) and the protocol version
// of packages/shared/src/mcpApp.ts.
import type { AgentMcpApp } from "@jhin/agent-api";

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 16;
const TEARDOWN_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();

type JsonRpcId = string | number;

export interface McpAppHostContext {
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: "inline";
  readonly availableDisplayModes: readonly "inline"[];
  readonly containerDimensions: { readonly width: number; readonly maxHeight: number };
  readonly platform: "web";
  readonly locale?: string;
  readonly timeZone?: string;
}

export interface McpAppCallToolResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly _meta?: unknown;
}

export interface McpAppHostOptions {
  readonly app: AgentMcpApp;
  readonly hostVersion: string;
  readonly post: (message: unknown) => void;
  readonly hostContext: () => McpAppHostContext;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<McpAppCallToolResult>;
  readonly readResource: (input: { readonly uri: string }) => Promise<unknown>;
  readonly openLink: (url: string) => Promise<void>;
  readonly sendMessage: (text: string) => Promise<void>;
  readonly onRequestTeardown: () => void;
  readonly onSizeChanged: (size: { readonly width?: number; readonly height?: number }) => void;
}

export interface McpAppHost {
  /** Handles one message the app posted; the caller has checked its source. */
  receive(data: unknown): void;
  setToolCall(call: {
    readonly arguments: unknown;
    readonly result: McpAppCallToolResult | undefined;
  }): void;
  updateHostContext(): void;
  /** Asks the app to wrap up before its document goes (`ui/resource-teardown`), then disposes. */
  teardown(): Promise<void>;
  dispose(): void;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Absent fields as the MCP Apps SDK wants them: Codex sends `_meta: null`. */
export function normalizeMcpAppToolResult(result: McpAppCallToolResult): McpAppCallToolResult {
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
  };
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";

export function makeMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let initialized = false;
  let disposed = false;
  let toolCall:
    | { readonly arguments: unknown; readonly result: McpAppCallToolResult | undefined }
    | undefined;
  let toolCallSent = false;
  let pending = 0;
  let sentContext: McpAppHostContext | undefined;
  let nextHostRequestId = 0;
  const hostRequests = new Map<string, () => void>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const sendToolCall = () => {
    if (!initialized || toolCall === undefined || toolCallSent) return;
    toolCallSent = true;
    notify("ui/notifications/tool-input", {
      arguments: isRecord(toolCall.arguments) ? toolCall.arguments : {},
    });
    if (toolCall.result !== undefined) {
      notify("ui/notifications/tool-result", normalizeMcpAppToolResult(toolCall.result));
    }
  };

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      },
    );
  };

  const handleRequest = (id: JsonRpcId, method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ui/initialize": {
        const requested = params["protocolVersion"];
        sentContext = options.hostContext();
        respond(id, {
          protocolVersion:
            requested === MCP_APP_PROTOCOL_VERSION ? requested : MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "jhin", version: options.hostVersion },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            message: { text: {} },
            sandbox: {
              ...(options.app.csp === undefined ? {} : { csp: options.app.csp }),
              ...(options.app.permissions === undefined
                ? {}
                : {
                    permissions: Object.fromEntries(
                      options.app.permissions.map((permission) => [permission, {}]),
                    ),
                  }),
            },
          },
          hostContext: sentContext,
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "tools/call": {
        const name = params["name"];
        const args = params["arguments"] ?? {};
        if (typeof name !== "string" || name.trim() === "" || !isRecord(args)) {
          fail(id, -32602, "tools/call needs a tool name and object arguments.");
          return;
        }
        answer(id, () =>
          options
            .callTool({ name, arguments: args as Record<string, unknown> })
            .then(normalizeMcpAppToolResult),
        );
        return;
      }
      case "resources/read": {
        const uri = params["uri"];
        if (typeof uri !== "string" || uri.trim() === "") {
          fail(id, -32602, "resources/read needs a uri.");
          return;
        }
        answer(id, () => options.readResource({ uri }));
        return;
      }
      case "ui/open-link": {
        const url = params["url"];
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          fail(id, -32602, "Only http(s) links can be opened.");
          return;
        }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case "ui/message": {
        // The SDK sends an array of content blocks; the spec text shows one block.
        const content = params["content"];
        const blocks = Array.isArray(content) ? content : [content];
        const texts = blocks.map((block) =>
          isRecord(block) && block["type"] === "text" && typeof block["text"] === "string"
            ? block["text"]
            : undefined,
        );
        if (params["role"] !== "user" || texts.length === 0 || texts.includes(undefined)) {
          fail(id, -32602, "Only text messages from the user role are supported.");
          return;
        }
        const text = texts.join("\n").trim();
        if (text === "") {
          fail(id, -32602, "ui/message needs non-empty text.");
          return;
        }
        answer(id, () => options.sendMessage(text).then(() => ({})));
        return;
      }
      case "ui/request-display-mode":
        // Only inline here: the spec has the host answer with the mode that applies.
        respond(id, { mode: "inline" });
        return;
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ui/notifications/initialized":
        if (initialized) return;
        initialized = true;
        sendToolCall();
        host.updateHostContext();
        return;
      case "ui/notifications/size-changed": {
        const width = typeof params["width"] === "number" ? params["width"] : undefined;
        const height = typeof params["height"] === "number" ? params["height"] : undefined;
        if (width !== undefined || height !== undefined) {
          options.onSizeChanged({
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          });
        }
        return;
      }
      case "ui/notifications/request-teardown":
        options.onRequestTeardown();
        return;
      default:
    }
  };

  const host: McpAppHost = {
    receive(data) {
      if (disposed || !isRecord(data) || data["jsonrpc"] !== "2.0") return;
      if (jsonBytes(data) > MAX_MESSAGE_BYTES) {
        if (isId(data["id"]) && typeof data["method"] === "string") {
          fail(data["id"], -32600, "Message too large.");
        }
        return;
      }
      const method = data["method"];
      if (typeof method !== "string") {
        if (isId(data["id"]) && ("result" in data || "error" in data)) {
          const settle = hostRequests.get(String(data["id"]));
          hostRequests.delete(String(data["id"]));
          settle?.();
        }
        return;
      }
      const params = isRecord(data["params"]) ? data["params"] : {};
      if (isId(data["id"])) handleRequest(data["id"], method, params);
      else handleNotification(method, params);
    },
    setToolCall(call) {
      toolCall ??= call;
      sendToolCall();
    },
    updateHostContext() {
      // No message before the app initialized: it reads the context from its answer.
      if (!initialized || sentContext === undefined) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as (keyof McpAppHostContext)[]) {
        if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key])) {
          changes[key] = next[key];
        }
      }
      sentContext = next;
      if (Object.keys(changes).length > 0) notify("ui/notifications/host-context-changed", changes);
    },
    teardown: () =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          clearTimeout(timer);
          disposed = true;
          resolve();
        };
        if (disposed || !initialized) {
          finish();
          return;
        }
        const id = `jhin-host-${nextHostRequestId++}`;
        hostRequests.set(id, finish);
        timer = setTimeout(() => {
          hostRequests.delete(id);
          finish();
        }, TEARDOWN_TIMEOUT_MS);
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      }),
    dispose() {
      disposed = true;
    },
  };
  return host;
}

/** The app's style variables from the client's theme (T3's mcpAppStyleVariables). */
export function mcpAppStyleVariables(
  theme: Readonly<Record<string, string>>,
): Record<string, string> {
  const pairs: readonly (readonly [string, string])[] = [
    ["--color-background-primary", "--background"],
    ["--color-background-secondary", "--card"],
    ["--color-background-tertiary", "--muted"],
    ["--color-background-inverse", "--foreground"],
    ["--color-text-primary", "--foreground"],
    ["--color-text-secondary", "--muted-foreground"],
    ["--color-text-tertiary", "--muted-foreground"],
    ["--color-text-inverse", "--background"],
    ["--color-border-primary", "--border"],
    ["--color-border-secondary", "--input"],
    ["--color-ring-primary", "--ring"],
    ["--font-sans", "--font-sans"],
    ["--font-mono", "--font-mono"],
    ["--border-radius-md", "--radius"],
  ];
  const variables: Record<string, string> = {};
  for (const [name, source] of pairs) {
    const value = theme[source];
    if (value !== undefined && value !== "") variables[name] = value;
  }
  return variables;
}

const MIN_HEIGHT = 80;
export const MCP_APP_DEFAULT_HEIGHT = 320;
export const MCP_APP_MAX_HEIGHT = 2000;

export function clampMcpAppHeight(height: number): number {
  if (!Number.isFinite(height)) return MCP_APP_DEFAULT_HEIGHT;
  return Math.round(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
}

/** The `allow` attribute of the frame: the features the app asked for. */
export function mcpAppAllowAttribute(permissions: AgentMcpApp["permissions"]): string {
  const names: Record<NonNullable<AgentMcpApp["permissions"]>[number], string> = {
    camera: "camera",
    microphone: "microphone",
    geolocation: "geolocation",
    clipboardWrite: "clipboard-write",
  };
  return (permissions ?? []).map((permission) => names[permission]).join("; ");
}
