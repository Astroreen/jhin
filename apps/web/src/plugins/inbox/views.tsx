// The owner's inbox in Civilization mode (D626, D630), a chunk of its own
// (D440): the page loads it once Civilization mode shows it.
import type { AgentMessage, InboxItem } from "@jhin/agent-api";
import type { Connections, Navigation } from "@jhin/client-api";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  Textarea,
  type Toasts,
} from "@jhin/ui";
import { InboxIcon, MessageCircleQuestionIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { notLive } from "../../lib/node-feeds.ts";
import { INBOX_PANEL, inboxRoute, senderLabel } from "./route.ts";
import { openItems, type InboxStore } from "./store.ts";

/** What the views use of the plugin that shows them. */
export interface InboxView {
  readonly store: InboxStore;
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly toasts: Toasts | undefined;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** The open items of every node in `civilization.sidebar.inbox`, oldest first (D630). */
export function InboxList({ view }: { view: InboxView }) {
  const nodes = useExternal(view.store, view.store.snapshot);
  const route = useExternal(view.navigation, view.navigation.current);
  const items = openItems(nodes);
  const stale = notLive(nodes);
  const notice =
    stale.length === 0 ? null : (
      <p className="px-2 py-1 text-xs text-destructive">
        Not live: {stale.map((node) => view.connections.get(node)?.label ?? node).join(", ")}. What
        shows may be out of date.
      </p>
    );
  if (items.length === 0) {
    return (
      <>
        {notice}
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">Nothing waits for you.</p>
      </>
    );
  }
  return (
    <SidebarMenu aria-label="Inbox">
      {notice}
      {items.map(({ node, item }) => {
        const { message } = item;
        const Icon = message.kind === "ask" ? MessageCircleQuestionIcon : MessageSquareIcon;
        return (
          <SidebarMenuItem key={`${node}|${message.messageId}`}>
            <SidebarMenuButton
              className="h-auto py-1.5"
              isActive={
                route.panel === INBOX_PANEL &&
                route.node === node &&
                route.section === message.messageId
              }
              onClick={() => view.navigation.navigate(inboxRoute(node, message.messageId))}
            >
              <Icon />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs text-sidebar-muted-foreground">
                  {senderLabel(message.from)}
                </span>
                <span className="truncate">{firstLine(message.body)}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

function PageEmpty({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InboxIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Meta({ message }: { message: AgentMessage }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <dt>From</dt>
      <dd className="font-mono break-all">{message.from}</dd>
      <dt>Sent</dt>
      <dd>{new Date(message.sentAt).toLocaleString()}</dd>
      <dt>Trace</dt>
      <dd className="font-mono break-all">{message.traceId}</dd>
    </dl>
  );
}

/**
 * An inbox item in `civilization.views` (D630): what the agent sent, who and
 * the trace, and the owner's answer, which goes back to it as a message.
 */
export function InboxPage(props: { view: InboxView; node: string; messageId: string }) {
  const { view, node, messageId } = props;
  const nodes = useExternal(view.store, view.store.snapshot);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const state = nodes.get(node);
  const item: InboxItem | undefined = state?.value.find(
    (entry) => entry.message.messageId === messageId,
  );
  if (state === undefined || state.status === "loading") {
    return <PageEmpty text="Loading the inbox…" title="Inbox" />;
  }
  if (item === undefined) {
    return (
      <PageEmpty
        text="This message is answered already, or the node no longer has it."
        title="Nothing to answer"
      />
    );
  }
  const { message } = item;
  const send = async () => {
    const connection = view.connections.get(node);
    if (connection === undefined) return;
    setSending(true);
    try {
      await connection.client.call("agents.inbox.answer", { messageId, answer: answer.trim() });
      view.toasts?.show({ type: "success", title: "Answer sent", description: message.from });
    } catch (error) {
      view.toasts?.show({
        type: "error",
        title: "Couldn't send the answer",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      aria-label={message.kind === "ask" ? "Question" : "Message"}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      <header className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">
          {message.kind === "ask" ? "Question" : "Message"} from {senderLabel(message.from)}
        </h1>
        <Badge variant={message.kind === "ask" ? "warning" : "secondary"}>
          {message.kind === "ask" ? "Waiting for your answer" : "Open"}
        </Badge>
      </header>
      <Meta message={message} />
      {state.status === "error" ? (
        <p className="text-xs text-destructive">
          Not live: {state.error ?? "the node's inbox stream failed"}. This item may be answered
          already; the inbox is read again within a minute.
        </p>
      ) : null}
      <p className="max-w-3xl text-sm whitespace-pre-wrap">{message.body}</p>
      <form
        className="flex max-w-3xl flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim() !== "" && !sending) void send();
        }}
      >
        <Textarea
          aria-label="Your answer"
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Your answer goes back to the agent as a message."
          rows={5}
          value={answer}
        />
        <div>
          <Button disabled={answer.trim() === "" || sending} type="submit">
            Send answer
          </Button>
        </div>
      </form>
    </section>
  );
}
