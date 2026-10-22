// Teams in Civilization mode (docs/plans/agents.md, A5: D691), a chunk of its
// own (D440): loaded once the Teams section or a team's page shows.
import type { AgentStatus, TeamRecord } from "@jhin/agent-api";
import type { Connections, Navigation, Route } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
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
  type Toasts,
} from "@jhin/ui";
import { CrownIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { useExternal } from "../../lib/hooks.ts";
import {
  STATUS_LABELS,
  TEAM_PANEL,
  isUp,
  leadRoute,
  nodeLabel,
  statusVariant,
  teamRoute,
} from "./route.ts";
import { createTeamsStore, type TeamsStore, type TeamsView } from "./store.ts";

export { createTeamsStore };

/** What the views use of the plugin that shows them. */
export interface TeamsServices {
  readonly navigation: Navigation;
  readonly connections: Connections;
  readonly toasts: Toasts | undefined;
  readonly store: TeamsStore;
  readonly commands: Pick<PluginContext["commands"], "execute">;
}

/** The route's connection, or the first open one when the route names none. */
export function useConnection(services: TeamsServices, route: Route): string | undefined {
  const nodes = useExternal(services.connections, services.connections.list);
  return (
    route.node ?? nodes.find((node) => node.state === "open")?.id ?? nodes.at(0)?.id ?? undefined
  );
}

const NO_VIEW: TeamsView = { status: "loading", teams: [] };

export function useTeams(store: TeamsStore, connection: string | undefined): TeamsView {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      if (connection === undefined) return () => undefined;
      const subscription = store.subscribe(connection, listener);
      return () => subscription.dispose();
    },
    [store, connection],
  );
  return useSyncExternalStore(subscribe, () =>
    connection === undefined ? NO_VIEW : store.view(connection),
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Note({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">{children}</p>;
}

/** The teams of the route's node in `civilization.sidebar.teams` (D691). */
export function TeamsSidebar({ services }: { services: TeamsServices }) {
  const route = useExternal(services.navigation, services.navigation.current);
  const connection = useConnection(services, route);
  const view = useTeams(services.store, connection);
  if (view.status === "loading") return <Note>Loading teams…</Note>;
  if (view.status === "unavailable") return <Note>This node has no teams.</Note>;
  if (view.status === "error") return <Note>Couldn't load teams: {view.error}</Note>;
  if (view.teams.length === 0) {
    return <Note>No teams yet. Define one in jhin.teams, or install a team bundle.</Note>;
  }
  return (
    <SidebarMenu aria-label="Teams">
      {view.teams.map((team) => (
        <SidebarMenuItem key={team.teamId}>
          <SidebarMenuButton
            className="h-auto py-1.5"
            isActive={route.panel === TEAM_PANEL && route.section === team.teamId}
            onClick={() => services.navigation.navigate(teamRoute(route, team.teamId))}
          >
            <UsersIcon />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{team.title}</span>
              <span className="truncate text-xs text-sidebar-muted-foreground">
                {team.error === undefined
                  ? `${team.members.length} agents · ${isUp(team) ? "up" : team.upAt === undefined ? "not up" : "stopped"}`
                  : "invalid"}
              </span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function PageEmpty({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** A team's page in `civilization.views`: only for its own panel (D750). */
export function TeamsMain({ services }: { services: TeamsServices }) {
  const route = useExternal(services.navigation, services.navigation.current);
  const connection = useConnection(services, route);
  const view = useTeams(services.store, connection);
  if (route.panel !== TEAM_PANEL || route.section === undefined) return null;
  if (connection === undefined || view.status === "loading") {
    return <PageEmpty text="Loading the team…" title="Team" />;
  }
  const team = view.teams.find((item) => item.teamId === route.section);
  if (team === undefined) {
    return <PageEmpty text="This node has no such team." title="No team" />;
  }
  return <TeamPage connection={connection} key={team.teamId} services={services} team={team} />;
}

function TeamPage(props: { services: TeamsServices; connection: string; team: TeamRecord }) {
  const { services, connection, team } = props;
  const route = useExternal(services.navigation, services.navigation.current);
  const client = services.connections.get(connection)?.client;
  const [status, setStatus] = useState<Record<string, AgentStatus | "absent">>({});
  const [busy, setBusy] = useState(false);
  const up = isUp(team);

  // Statuses at open and whenever the team changes; they are not followed live (Deferred).
  useEffect(() => {
    if (client === undefined || team.error !== undefined) return;
    let current = true;
    client
      .call<{ status: Record<string, AgentStatus | "absent"> }>("teams.get", {
        teamId: team.teamId,
      })
      .then((answer) => current && setStatus(answer.status))
      .catch(() => current && setStatus({}));
    return () => {
      current = false;
    };
  }, [client, team]);

  const act = async (method: "teams.up" | "teams.down") => {
    if (client === undefined) return;
    setBusy(true);
    try {
      const answer = await client.call<{
        members: { member: string; error?: { message: string } }[];
      }>(method, { teamId: team.teamId });
      const failed = answer.members.filter((member) => member.error !== undefined);
      if (failed.length > 0) {
        services.toasts?.show({
          type: "warning",
          title: method === "teams.up" ? "Some agents did not start" : "Some agents did not stop",
          description: failed
            .map((member) => `${member.member}: ${member.error!.message}`)
            .join("\n"),
        });
      }
    } catch (error) {
      services.toasts?.show({
        type: "error",
        title: method === "teams.up" ? "Couldn't start the team" : "Couldn't stop the team",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
      services.store.refresh(connection);
    }
  };

  return (
    <section
      aria-label={`Team ${team.title}`}
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{team.title}</h1>
        <Badge variant={up ? "success" : "secondary"}>
          {up ? "Up" : team.upAt === undefined ? "Not up" : "Stopped"}
        </Badge>
        {team.bundle === undefined ? null : <Badge variant="outline">Bundle {team.bundle}</Badge>}
        <div className="ml-auto flex gap-2">
          {team.error === undefined ? (
            <Button
              onClick={() => services.navigation.navigate(leadRoute(route, team.teamId))}
              variant="outline"
            >
              Talk to the lead
            </Button>
          ) : null}
          {up ? (
            <Button disabled={busy} onClick={() => void act("teams.down")} variant="outline">
              Stop team
            </Button>
          ) : (
            <Button
              disabled={busy || team.error !== undefined}
              onClick={() => void act("teams.up")}
            >
              Start team
            </Button>
          )}
        </div>
      </header>
      {team.description === undefined ? null : (
        <p className="max-w-3xl text-sm text-muted-foreground">{team.description}</p>
      )}
      {team.error === undefined ? null : (
        <p className="max-w-3xl text-sm text-destructive-foreground" role="alert">
          The team's spec is invalid: {team.error}
        </p>
      )}
      {team.members.length === 0 ? null : (
        <Section title="Agents">
          <ul aria-label="Agents" className="flex max-w-3xl flex-col divide-y divide-border">
            {team.members.map((member) => {
              const state = status[member.member];
              return (
                <li className="flex items-center gap-3 py-2" key={member.member}>
                  {member.lead ? (
                    <CrownIcon aria-label="Lead" className="size-4 shrink-0 text-warning" />
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-sm">{member.alias}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {member.role} · {member.runtime}
                      {member.model === undefined ? "" : ` (${member.model})`} · node{" "}
                      {nodeLabel(member.nodeId)}
                    </span>
                  </span>
                  {state === undefined ? null : (
                    <Badge size="sm" variant={statusVariant(state)}>
                      {STATUS_LABELS[state]}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {team.culture === undefined || team.culture.trim() === "" ? null : (
        <Section title="Culture">
          <p className="max-w-3xl whitespace-pre-wrap break-words text-sm leading-relaxed">
            {team.culture}
          </p>
        </Section>
      )}
    </section>
  );
}
