// The conversation with the lead in Civilization mode (docs/plans/agents.md,
// C1: D1062–D1064), a chunk of its own (D440): loaded once the Lead view shows.
// The owner talks to the agent (`agents.ask`), never to one of its generations.
import type { ConversationEntry, TeamRecord } from "@jhin/agent-api";
import type { Route } from "@jhin/client-api";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Spinner,
  cn,
} from "@jhin/ui";
import { ArrowUpIcon, ClipboardListIcon, CrownIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { MessageText } from "../chat/message-text.tsx";
import { CONVERSATION_LOADING, followConversation, unanswered } from "./conversation.ts";
import type { ConversationView } from "./conversation.ts";
import { chosenTeam, isUp, leadRoute, teamRoute } from "./route.ts";
import { useConnection, useTeams, type TeamsServices } from "./view.tsx";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function LeadEmpty({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CrownIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** `civilization.lead`: the conversation with the chosen team's lead (D1062). */
export function LeadConsole({ services }: { services: TeamsServices }) {
  const route = useExternal(services.navigation, services.navigation.current);
  const connection = useConnection(services, route);
  const view = useTeams(services.store, connection);
  if (connection === undefined || view.status === "loading") {
    return <LeadEmpty text="Loading the teams…" title="Lead" />;
  }
  if (view.status === "error") {
    return <LeadEmpty text={`Couldn't load the teams: ${view.error}`} title="Lead" />;
  }
  const team = view.status === "ready" ? chosenTeam(view.teams, route) : undefined;
  if (team === undefined && route.section !== undefined && view.status === "ready") {
    return (
      <LeadEmpty
        text={`This node has no team ${route.section} whose lead you could talk to.`}
        title="No such team"
      />
    );
  }
  if (team === undefined) {
    return (
      <LeadEmpty
        text="You talk to a team's lead. Define a team in jhin.teams or install a team bundle, then start it."
        title="No team yet"
      />
    );
  }
  return (
    <Conversation
      connection={connection}
      key={`${connection}|${team.teamId}`}
      route={route}
      services={services}
      team={team}
      teams={view.teams.filter((item) => item.error === undefined)}
    />
  );
}

function Conversation(props: {
  services: TeamsServices;
  connection: string;
  route: Route;
  team: TeamRecord;
  teams: readonly TeamRecord[];
}) {
  const { services, connection, route, team } = props;
  const client = services.connections.get(connection)?.client;
  const lead = `${team.lead}@${team.teamId}`;
  const up = isUp(team);
  const [view, setView] = useState<ConversationView>(CONVERSATION_LOADING);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  /** The latest entries, for a failed ask to tell whether it was recorded anyway. */
  const entries = useRef(view.entries);
  entries.current = view.entries;

  /** The asks this page sent and still waits on, by message id (D1063). */
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Answers the page got from its own asks, shown before the stream brings them. */
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** Bumped by Retry: following again after the feed failed. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (client === undefined) return;
    const following = followConversation(client, lead, setView);
    return () => following.dispose();
  }, [client, lead, attempt]);

  // The newest message in view, as a chat does.
  useEffect(() => {
    const element = log.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [view.entries.length, view.entries.at(-1)?.answer]);

  const start = async () => {
    if (client === undefined) return;
    setStarting(true);
    try {
      await client.call("teams.up", { teamId: team.teamId });
    } catch (error) {
      services.toasts?.show({
        type: "error",
        title: "Couldn't start the team",
        description: errorText(error),
      });
    } finally {
      setStarting(false);
      services.store.refresh(connection);
    }
  };

  /** Tells the lead without waiting for an answer (D1382): no pending entry, no spinner. */
  const tell = () => {
    const body = draft.trim();
    if (client === undefined || body === "" || !up) return;
    setDraft("");
    client
      .call("agents.send", { to: lead, body, messageId: crypto.randomUUID() })
      .catch((error: unknown) => {
        // Nothing was recorded for a send that failed: the text comes back, if the composer is still empty.
        setDraft((now) => (now === "" ? body : now));
        services.toasts?.show({
          type: "error",
          title: "Couldn't reach the lead",
          description: errorText(error),
        });
      });
  };

  const send = () => {
    const question = draft.trim();
    if (client === undefined || question === "" || !up) return;
    // The page names the ask, so it knows which one it waits on.
    const messageId = crypto.randomUUID();
    const settle = () =>
      setPending((now) => {
        const next = new Set(now);
        next.delete(messageId);
        return next;
      });
    setPending((now) => new Set(now).add(messageId));
    setDraft("");
    // The ask lands on the stream at once; its answer when the lead's turn ends
    // (D624). The call brings the answer too, so it shows even if the feed lags.
    client.call<{ answer?: string }>("agents.ask", { to: lead, question, messageId }).then(
      (result) => {
        const answer = result.answer;
        if (answer !== undefined) setAnswers((now) => new Map(now).set(messageId, answer));
        settle();
      },
      (error: unknown) => {
        settle();
        const silent = (error as { code?: unknown } | null)?.code === "NO_ANSWER";
        const recorded = entries.current.some((entry) => entry.message.messageId === messageId);
        // A text that never reached the lead comes back to the composer, if it is still empty.
        if (!silent && !recorded) setDraft((now) => (now === "" ? question : now));
        services.toasts?.show({
          type: silent ? "warning" : "error",
          title: silent ? "The lead's turn ended without an answer" : "Couldn't reach the lead",
          description: errorText(error),
        });
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const shown = view.entries.map((entry) => {
    const answer = entry.answer ?? answers.get(entry.message.messageId);
    return answer === entry.answer ? entry : { ...entry, answer };
  });
  const waiting = shown.some(
    (entry) => pending.has(entry.message.messageId) && unanswered(entry, view.owner),
  );
  return (
    <section aria-label="Lead view" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border px-4">
        <CrownIcon aria-hidden className="size-4 shrink-0 text-warning" />
        <h1 className="text-sm font-medium">Lead</h1>
        <span className="truncate font-mono text-xs text-muted-foreground">{lead}</span>
        <Badge size="sm" variant={up ? "success" : "secondary"}>
          {up ? "Up" : team.upAt === undefined ? "Not up" : "Stopped"}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          {props.teams.length > 1 ? (
            <Select
              onValueChange={(value) => {
                if (typeof value === "string" && value !== team.teamId) {
                  services.navigation.navigate(leadRoute(route, value));
                }
              }}
              value={team.teamId}
            >
              <SelectTrigger aria-label="Team" className="w-44" size="sm">
                <SelectValue>{team.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {props.teams.map((item) => (
                  <SelectItem key={item.teamId} value={item.teamId}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Button
            onClick={() => services.navigation.navigate(teamRoute(route, team.teamId))}
            size="sm"
            variant="ghost"
          >
            Team page
          </Button>
          {up ? null : (
            <Button disabled={starting} onClick={() => void start()} size="sm">
              Start team
            </Button>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" ref={log}>
        <div
          aria-label="Conversation with the lead"
          className="mx-auto flex w-full max-w-3xl flex-col px-5 py-6"
          role="log"
        >
          {view.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading the conversation…</p>
          ) : view.status === "unavailable" ? (
            <p className="text-sm text-muted-foreground">
              This node keeps no conversation with its agents you may read.
            </p>
          ) : view.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Say what you want done. {team.title}'s lead answers here, and what only you can decide
              comes back here and in your inbox.
            </p>
          ) : (
            shown.map((entry) => (
              <Entry
                entry={entry}
                key={entry.message.messageId}
                lead={view.lead}
                owner={view.owner}
                pending={pending.has(entry.message.messageId)}
                services={services}
                connection={connection}
              />
            ))
          )}
          <div aria-live="polite">
            {waiting ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-3.5" /> The lead is working on an answer…
              </p>
            ) : null}
          </div>
          {view.status === "error" ? (
            <p className="flex items-center gap-2 text-sm text-destructive-foreground" role="alert">
              Not live: {view.error}
              <Button onClick={() => setAttempt((now) => now + 1)} size="xs" variant="outline">
                Retry
              </Button>
            </p>
          ) : null}
        </div>
      </div>
      <form
        className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-xs/5 focus-within:border-ring">
          <textarea
            aria-label="Message to the lead"
            className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
            disabled={!up}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={up ? `Ask ${lead}…` : "Start the team to talk to its lead."}
            rows={2}
            value={draft}
          />
          <Button
            disabled={!up || draft.trim() === ""}
            onClick={tell}
            size="sm"
            type="button"
            variant="ghost"
          >
            Tell without waiting
          </Button>
          <Button
            aria-label="Send to the lead"
            className="rounded-full"
            disabled={!up || draft.trim() === ""}
            size="icon-sm"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
    </section>
  );
}

function OwnerBubble({ text, caption }: { text: string; caption?: string | undefined }) {
  return (
    <div className="flex flex-col items-end gap-1 pb-4">
      {caption === undefined ? null : (
        <span className="pe-1 text-xs text-muted-foreground">{caption}</span>
      )}
      <article
        aria-label="You"
        className="max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
      >
        <MessageText className="text-foreground" lineBreaks text={text} />
      </article>
    </div>
  );
}

function LeadText({ text }: { text: string }) {
  return (
    <article aria-label="Lead" className="pb-4">
      <MessageText text={text} />
    </article>
  );
}

/**
 * A mission report (D1222) is the lead's message with the id
 * `report-<missionId>-<…>` and a first line `Mission report: <title>, <end>`.
 * Only the lead's counts: the same id from another sender is text (D1393).
 */
function reportOf(
  message: ConversationEntry["message"],
  lead: string | undefined,
): { missionId: string; headline: string } | undefined {
  const missionId = /^report-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/.exec(
    message.messageId,
  )?.[1];
  if (missionId === undefined || lead === undefined || message.from !== lead) return undefined;
  const first = message.body.split("\n", 1)[0] ?? "";
  if (!first.startsWith(REPORT_PREFIX)) return undefined;
  return { missionId, headline: first.slice(REPORT_PREFIX.length) };
}
const REPORT_PREFIX = "Mission report: ";

/** The lead's report on a mission, a card of its own like the lead's ask (D1393). */
function ReportCard(props: {
  body: string;
  headline: string;
  missionId: string;
  connection: string;
  services: TeamsServices;
}) {
  return (
    <article
      aria-label="Mission report"
      className="mb-4 flex flex-col gap-2 rounded-xl border border-border p-3"
    >
      <div className="flex items-center gap-2 text-xs">
        <ClipboardListIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Mission report</span>
        <Button
          className="ml-auto"
          onClick={() =>
            void props.services.commands
              .execute("civilization.mission.open", {
                node: props.connection,
                missionId: props.missionId,
              })
              .catch((error: unknown) =>
                props.services.toasts?.show({
                  type: "error",
                  title: "Couldn't open the mission",
                  description: errorText(error),
                }),
              )
          }
          size="xs"
          variant="outline"
        >
          Open mission
        </Button>
      </div>
      <p className="text-sm font-medium">{props.headline}</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Full report</summary>
        <div className="pt-2">
          <MessageText text={props.body} />
        </div>
      </details>
    </article>
  );
}

function Entry(props: {
  entry: ConversationEntry;
  owner: string | undefined;
  /** The lead's address, as the node resolved it. */
  lead: string | undefined;
  /** Whether this page waits on its answer. */
  pending: boolean;
  services: TeamsServices;
  connection: string;
}) {
  const { entry, owner } = props;
  const { message } = entry;
  if (message.from === owner) {
    return (
      <>
        <OwnerBubble
          caption={
            message.kind === "answer"
              ? "Your answer to the lead"
              : message.kind === "message"
                ? "Told, not asked"
                : undefined
          }
          text={message.body}
        />
        {entry.answer !== undefined ? (
          <LeadText text={entry.answer} />
        ) : unanswered(entry, owner) && !props.pending ? (
          <p className="pb-4 text-xs text-muted-foreground">No answer from the lead.</p>
        ) : null}
      </>
    );
  }
  if (message.kind !== "ask") {
    const report = reportOf(message, props.lead);
    return report === undefined ? (
      <LeadText text={message.body} />
    ) : (
      <ReportCard
        body={message.body}
        connection={props.connection}
        headline={report.headline}
        missionId={report.missionId}
        services={props.services}
      />
    );
  }
  // An escalation: the lead asks what only the owner can decide (D688); it is
  // answered in the inbox, which tells the lead (D626).
  const open = entry.inbox === "open";
  const dismissed = entry.inbox === "dismissed";
  return (
    <article
      aria-label="The lead asks you"
      className={cn(
        "mb-4 flex flex-col gap-2 rounded-xl border p-3",
        open ? "border-warning/40 bg-warning/4" : "border-border",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <MessageCircleQuestionIcon aria-hidden className="size-3.5 text-warning" />
        <span className="font-medium">The lead asks you</span>
        <Badge size="sm" variant={open ? "warning" : "secondary"}>
          {open ? "Waiting for you" : dismissed ? "Dismissed" : "Answered"}
        </Badge>
        {open ? (
          <Button
            className="ml-auto"
            onClick={() =>
              void props.services.commands
                .execute("civilization.inbox.open", {
                  node: props.connection,
                  messageId: message.messageId,
                })
                .catch((error: unknown) =>
                  props.services.toasts?.show({
                    type: "error",
                    title: "Couldn't open it in the inbox",
                    description: errorText(error),
                  }),
                )
            }
            size="xs"
            variant="outline"
          >
            Answer
          </Button>
        ) : null}
      </div>
      <MessageText text={message.body} />
    </article>
  );
}
