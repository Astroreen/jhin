// An MCP app in the timeline (providers.md D1403). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/components/chat/McpAppFrame.tsx (the
// sandboxed frame, its height, the host context, approvals before a call or a message, links
// only from a click, a frame that navigates away stops the app).
import type { AgentMcpApp } from "@jhin/agent-api";
import type { NodeTarget } from "@jhin/client-api";
import { useEffect, useRef, useState } from "react";

import {
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  clampMcpAppHeight,
  makeMcpAppHost,
  mcpAppAllowAttribute,
  mcpAppStyleVariables,
  type McpAppCallToolResult,
  type McpAppHost,
  type McpAppHostContext,
} from "../../lib/mcp-app-host.ts";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import { useChat } from "./services.ts";

/** The client's theme variables an app may follow. */
const THEME_VARIABLES = [
  "--background",
  "--card",
  "--muted",
  "--foreground",
  "--muted-foreground",
  "--border",
  "--input",
  "--ring",
  "--font-sans",
  "--font-mono",
  "--radius",
];

function themeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_VARIABLES.map((name) => [name, style.getPropertyValue(name).trim()]),
  );
}

export function McpAppFrame(props: {
  readonly target: NodeTarget;
  readonly threadId: string;
  readonly app: AgentMcpApp;
  /** What the call that returned it was asked, and what it answered. */
  readonly toolCall: { readonly arguments: unknown; readonly output: string };
}) {
  const { app } = props;
  const chat = useChat();
  const theme = useResolvedTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const [closed, setClosed] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const hostRef = useRef<McpAppHost | null>(null);
  const live = useRef({ props, theme, chat });
  live.current = { props, theme, chat };

  useEffect(() => {
    let cancelled = false;
    chat.threads
      .call<{ html: string }>(props.target, "agents.mcp-app.document", {
        threadId: props.threadId,
        documentId: app.documentId,
      })
      .then(
        (document) => {
          if (!cancelled) setHtml(document.html);
        },
        (failure: unknown) => {
          if (!cancelled) setError((failure as Error).message);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [chat.threads, props.target.node, props.target.remote, props.threadId, app.documentId]);

  // The bridge belongs to the document Jhin served: a frame that loads a second page stops it.
  const loads = useRef(0);
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      hostRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  useEffect(() => {
    if (html === undefined || closed) return;
    const confirm = async (title: string, description: string) => {
      const dialogs = live.current.chat.dialogs;
      if (dialogs === undefined) throw new Error("Jhin could not ask for approval here.");
      return dialogs.confirm({ title, description, confirmLabel: "Allow" });
    };
    const hostContext = (): McpAppHostContext => ({
      theme: live.current.theme,
      styles: { variables: mcpAppStyleVariables(themeVariables()) },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: {
        width: boxRef.current?.clientWidth ?? 0,
        maxHeight: MCP_APP_MAX_HEIGHT,
      },
      platform: "web",
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const call = <T,>(method: string, input: Record<string, unknown>) => {
      const { target, threadId } = live.current.props;
      return live.current.chat.threads.call<T>(target, method, { threadId, ...input });
    };
    const host = makeMcpAppHost({
      app,
      hostVersion: "jhin",
      // The document's origin is opaque, so "*" is the only target that reaches it; the window
      // reference is what scopes the message to this frame.
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, "*"),
      hostContext,
      // Every call of the app is the user's to allow: it runs with the agent's tools.
      callTool: async ({ name, arguments: args }) => {
        const allowed = await confirm(
          `Allow ${app.server} to run ${name}?`,
          JSON.stringify(args, null, 2),
        );
        if (!allowed) throw new Error("Declined by the user.");
        const { result } = await call<{ result: McpAppCallToolResult }>(
          "agents.mcp-app.call-tool",
          { server: app.server, tool: name, arguments: args },
        );
        return result;
      },
      readResource: async ({ uri }) =>
        (
          await call<{ result: unknown }>("agents.mcp-app.read-resource", {
            server: app.server,
            uri,
          })
        ).result,
      openLink: async (url) => {
        // Only from a click in the app, as T3 opens them.
        if (document.activeElement !== frameRef.current || !navigator.userActivation?.isActive) {
          throw new Error("Links open only from a click in the app.");
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
      sendMessage: async (text) => {
        const allowed = await confirm(`Send this message from ${app.server}?`, text);
        if (!allowed) throw new Error("Declined by the user.");
        await call("threads.queue.add", { text });
      },
      onRequestTeardown: () => setClosed(true),
      onSizeChanged: ({ height: next }) => {
        if (next !== undefined) setHeight(clampMcpAppHeight(next));
      },
    });
    hostRef.current = host;
    const onMessage = (event: MessageEvent) => {
      // The app's frame only: its origin is opaque, so its window is how it is known.
      if (event.source !== frameRef.current?.contentWindow) return;
      host.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    const { toolCall } = live.current.props;
    host.setToolCall({
      arguments: toolCall.arguments,
      result: { content: [{ type: "text", text: toolCall.output }] },
    });
    return () => {
      window.removeEventListener("message", onMessage);
      void host.teardown();
      hostRef.current = null;
    };
  }, [html, closed, app]);

  useEffect(() => hostRef.current?.updateHostContext(), [theme]);

  if (closed) return null;
  return (
    <div
      aria-label={`${app.server} app`}
      className={
        app.prefersBorder === false
          ? "my-2 min-w-0"
          : "my-2 min-w-0 overflow-hidden rounded-lg border border-border/60"
      }
      ref={boxRef}
      role="group"
    >
      {error !== undefined ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Could not load the app: {error}</p>
      ) : navigatedAway ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          The app left its page and was stopped.
        </p>
      ) : html === undefined ? null : (
        <iframe
          allow={mcpAppAllowAttribute(app.permissions)}
          className="block w-full border-0 bg-transparent"
          onLoad={onFrameLoad}
          ref={frameRef}
          // Scripts in an opaque origin: no cookies, storage or requests as the client.
          sandbox="allow-scripts allow-forms"
          srcDoc={html}
          style={{ height }}
          title={`${app.server}: ${app.tool}`}
        />
      )}
    </div>
  );
}
