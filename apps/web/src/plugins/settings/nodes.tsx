// Rows follow T3 Code's connections settings (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/EnvironmentRow.tsx and ConnectionsSettings.tsx.
import type { AgentInfo, NodeConnection, NodeTarget } from "@jhin/client-api";
import { Badge, Button, Spinner, cn } from "@jhin/ui";
import { BotIcon, PencilIcon, PlusIcon, RefreshCwIcon, ServerIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { SettingsEmpty, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

function StateDot({ state }: { state: NodeConnection["state"] }) {
  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center">
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          state === "open"
            ? "bg-success"
            : state === "connecting"
              ? "bg-warning"
              : "bg-destructive",
        )}
      />
    </span>
  );
}

function Agents({ target }: { target: NodeTarget }) {
  const { threads } = useSettingsServices();
  const [agents, setAgents] = useState<readonly AgentInfo[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = () => {
    setAgents(undefined);
    setError(undefined);
    threads
      .call<AgentInfo[]>(target, "agents.list")
      .then(setAgents, (failure: unknown) => setError((failure as Error).message));
  };
  useEffect(load, [threads, target.node, target.remote]);
  if (error !== undefined) return <p className="text-xs text-destructive-foreground">{error}</p>;
  if (agents === undefined) return <Spinner size="sm" tone="muted" />;
  if (agents.length === 0)
    return <p className="text-xs text-muted-foreground">No agent runtime on this node.</p>;
  return (
    <ul aria-label="Agents" className="mt-1.5 flex flex-col gap-1">
      {agents.map((agent) => (
        <li className="flex min-w-0 items-center gap-2 text-xs" key={agent.agentId}>
          <BotIcon className="size-3.5 shrink-0 text-icon-muted" />
          <span className="truncate font-medium text-foreground/90">{agent.name}</span>
          {agent.default ? (
            <Badge size="sm" variant="secondary">
              Default
            </Badge>
          ) : null}
          <span
            className={cn(
              "truncate",
              agent.available ? "text-muted-foreground" : "text-warning-foreground",
            )}
          >
            {agent.available
              ? [
                  agent.version,
                  `${agent.models.length} ${agent.models.length === 1 ? "model" : "models"}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : (agent.message ?? "Unavailable")}
          </span>
        </li>
      ))}
      <li>
        <Button className="-ms-1.5" onClick={load} size="xs" variant="ghost-muted">
          <RefreshCwIcon className="size-3" />
          Check again
        </Button>
      </li>
    </ul>
  );
}

function MeshMembers({ connection }: { connection: NodeConnection }) {
  const { mesh } = useSettingsServices();
  const members = useMeshMembers(mesh, connection.id) ?? [];
  const others = members.filter((member) => !member.self);
  if (others.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground/80 uppercase">Its mesh</span>
      {others.map((member) => (
        <div className="flex items-center gap-2 text-xs" key={member.nodeId}>
          <ServerIcon className="size-3.5 text-icon-muted" />
          <span className="font-medium">{member.name}</span>
          <span className={member.reachable ? "text-success-foreground" : "text-muted-foreground"}>
            {member.reachable ? "reachable" : "unreachable"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function NodesSection() {
  const { connections, navigation, dialogs } = useSettingsServices();
  const nodes = useExternal(connections, connections.list);
  return (
    <SettingsSection
      headerAction={
        <Button
          onClick={() => navigation.navigate({ ...navigation.current(), panel: "connect" })}
          size="xs"
          variant="ghost-muted"
        >
          <PlusIcon className="size-3" />
          <span>Add node</span>
        </Button>
      }
      title="Nodes"
    >
      {nodes.length === 0 ? <SettingsEmpty>No node connected.</SettingsEmpty> : null}
      {nodes.map((node) => (
        <div
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 sm:px-4"
          key={node.id}
        >
          <div className="pt-1">
            <StateDot state={node.state} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{node.label}</p>
            <div className="truncate text-xs text-muted-foreground">
              {node.url} · {node.state}
            </div>
            {node.state === "open" ? (
              <>
                <Agents target={{ node: node.id }} />
                <MeshMembers connection={node} />
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              aria-label={`Rename ${node.label}`}
              onClick={() =>
                void dialogs
                  ?.prompt({
                    title: "Rename node",
                    label: "Node name",
                    value: node.label,
                    confirmLabel: "Rename",
                  })
                  .then((label) => label !== undefined && connections.rename?.(node.id, label))
              }
              size="icon-xs"
              variant="ghost-muted"
            >
              <PencilIcon />
            </Button>
            <Button
              aria-label={`Disconnect ${node.label}`}
              onClick={() =>
                void (
                  dialogs?.confirm({
                    title: `Disconnect ${node.label}?`,
                    description:
                      "This device forgets the node and its token. The node keeps running.",
                    confirmLabel: "Disconnect",
                    variant: "destructive",
                  }) ?? Promise.resolve(true)
                ).then((confirmed) => {
                  if (confirmed) connections.remove(node.id);
                })
              }
              size="icon-xs"
              variant="ghost-muted"
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}
