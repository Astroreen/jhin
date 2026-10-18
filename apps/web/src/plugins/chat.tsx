import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
  type NodeConnection,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { Button, Input, Textarea, UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { builtin } from "../lib/builtin.ts";
import { useExternal } from "../lib/hooks.ts";
import { useMeshNodes } from "../lib/mesh.ts";
import { threadTarget } from "../lib/target.ts";
import { reduceTurns, type ChatTurn } from "../lib/turns.ts";
import { THREADS_CHANGED } from "./sidebar.tsx";

function useThreadEvents(
  node: NodeConnection,
  remote: string | undefined,
  threadId: string,
): { events: readonly StoredEvent[]; error: string | undefined } {
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    setEvents([]);
    setError(undefined);
    let disposed = false;
    let subscription: { dispose(): void } | undefined;
    // The stream to read: the thread itself, or this node's copy of a remote one (D26).
    void threadTarget(node, remote)
      .open(threadId)
      .then((stream) => {
        if (disposed) return;
        subscription = node.client.subscribe(stream, {}, (event) =>
          setEvents((previous) => [...previous, event]),
        );
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(`Cannot open this thread: ${(failure as Error).message}`);
      });
    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [node, remote, threadId]);
  return { events, error };
}

function Turn({ turn }: { turn: ChatTurn }) {
  return (
    <>
      <article
        aria-label="You"
        className="ml-auto max-w-[80%] rounded-2xl bg-message px-4 py-2 text-sm"
      >
        <p className="whitespace-pre-wrap">{turn.userText}</p>
      </article>
      <article
        aria-label="Agent"
        aria-busy={turn.status === "running"}
        className="max-w-full text-sm"
      >
        <p className="whitespace-pre-wrap leading-relaxed">{turn.assistantText}</p>
        {turn.status === "interrupted" && (
          <p className="mt-1 text-xs text-muted-foreground">Interrupted</p>
        )}
        {turn.status === "failed" && (
          <p role="alert" className="mt-1 text-xs text-error-foreground">
            Failed: {turn.error}
          </p>
        )}
      </article>
    </>
  );
}

function Composer(props: {
  running: boolean;
  onSend(text: string): Promise<void>;
  onStop(): void;
}) {
  const [text, setText] = useState("");
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (value === "" || props.running) return;
    setText("");
    await props.onSend(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mx-auto flex w-full max-w-[var(--chat-content-max-width)] items-end gap-2 rounded-2xl border bg-card p-2 shadow-composer transition-colors focus-within:border-ring/60"
    >
      <Textarea
        aria-label="Message"
        placeholder="Ask anything"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        unstyled
        className="flex-1"
        style={{ resize: "none" }}
      />
      {props.running ? (
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label="Stop"
          onClick={props.onStop}
        >
          <SquareIcon />
        </Button>
      ) : (
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={text.trim() === ""}>
          <ArrowUpIcon />
        </Button>
      )}
    </form>
  );
}

export const chatPlugin = builtin(
  "jhin.chat",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);

      function ThreadView({
        node,
        remote,
        threadId,
      }: {
        node: NodeConnection;
        remote: string | undefined;
        threadId: string;
      }) {
        const target = threadTarget(node, remote);
        const { events, error: openError } = useThreadEvents(node, remote, threadId);
        const turns = useMemo(() => reduceTurns(events), [events]);
        const running = turns.at(-1)?.status === "running";
        const end = useRef<HTMLDivElement>(null);
        useEffect(() => end.current?.scrollIntoView({ block: "end" }), [events]);
        const [error, setError] = useState<string | undefined>();

        return (
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              role="log"
              aria-label="Messages"
              className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
            >
              <div className="mx-auto flex max-w-[var(--chat-content-max-width)] flex-col gap-4">
                {turns.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground">No messages yet.</p>
                )}
                {turns.map((turn) => (
                  <Turn key={turn.turnId} turn={turn} />
                ))}
                <div ref={end} />
              </div>
            </div>
            <div className="px-4 pb-4">
              {(openError ?? error) !== undefined && (
                <p
                  role="alert"
                  className="mx-auto mb-2 max-w-[var(--chat-content-max-width)] text-xs text-error-foreground"
                >
                  {openError ?? error}
                </p>
              )}
              <Composer
                running={running}
                onSend={async (text) => {
                  setError(undefined);
                  try {
                    await target.call("threads.send", { threadId, text });
                  } catch (failure) {
                    setError((failure as Error).message);
                  }
                }}
                onStop={() =>
                  void node.client.call("threads.interrupt", { threadId }).catch(() => undefined)
                }
              />
            </div>
          </div>
        );
      }

      /** Leaves the current panel, keeping the rest of the route. */
      const closePanel = () => {
        const { panel: _panel, ...rest } = navigation.current();
        navigation.navigate(rest);
      };

      function Connect({ cancellable }: { cancellable: boolean }) {
        const [url, setUrl] = useState(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`,
        );
        const [token, setToken] = useState("");
        const [error, setError] = useState<string | undefined>();
        return (
          <form
            aria-label="Connect a node"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                connections.add({ url, token });
                setError(undefined);
                closePanel();
              } catch (failure) {
                setError(
                  failure instanceof z.ZodError
                    ? failure.issues.map((issue) => issue.message).join("; ")
                    : String(failure),
                );
              }
            }}
            className="mx-auto mt-24 flex w-full max-w-sm flex-col gap-3"
          >
            <h1 className="text-lg font-semibold">Connect a node</h1>
            <p className="text-sm text-muted-foreground">
              The token is printed by <code>jhin serve</code> on first start, or by{" "}
              <code>jhin auth.token.show</code>.
            </p>
            <Input
              aria-label="Node URL"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Input
              aria-label="Token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            {error !== undefined && (
              <p role="alert" className="text-xs text-error-foreground">
                {error}
              </p>
            )}
            <Button type="submit" disabled={token === ""}>
              Connect
            </Button>
            {cancellable && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  closePanel();
                }}
              >
                Cancel
              </Button>
            )}
          </form>
        );
      }

      function Main() {
        const route = useExternal(navigation, navigation.current);
        const nodes = useExternal(connections, connections.list);
        const node =
          route.node === undefined
            ? undefined
            : nodes.find((candidate) => candidate.id === route.node);
        // Called before any early return: hooks run in the same order every render.
        const members = useMeshNodes(node);
        if (nodes.length === 0 || route.panel === "connect")
          return <Connect cancellable={nodes.length > 0} />;
        if (
          node !== undefined &&
          route.remote !== undefined &&
          members !== undefined &&
          !members.some((member) => member.nodeId === route.remote && member.reachable)
        ) {
          // A remote node that left the mesh, or a deep link to an unknown one.
          return (
            <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3">
              <p className="text-sm font-medium">Node unreachable</p>
              <p className="text-sm text-muted-foreground">
                {node.label} has no route to it now. Its threads come back when it does.
              </p>
            </div>
          );
        }
        if (node === undefined || route.thread === undefined) {
          const first = nodes[0]!;
          const start = async () => {
            const thread = await first.client.call<{ id: string }>("threads.create", {});
            context.events.emit(THREADS_CHANGED, { node: first.id });
            navigation.navigate({ node: first.id, thread: thread.id });
          };
          return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <p className="text-sm text-muted-foreground">Pick a thread, or start a new one.</p>
              <Button
                variant="outline"
                disabled={first.state !== "open"}
                onClick={() => void start()}
              >
                Start a thread
              </Button>
            </div>
          );
        }
        return (
          <ThreadView
            key={`${node.id}:${route.remote ?? ""}:${route.thread}`}
            node={node}
            remote={route.remote}
            threadId={route.thread}
          />
        );
      }

      context.subscriptions.add(
        slots.contribute("app.main", { id: "jhin.chat.view", component: Main }),
      );
    },
  }),
);
