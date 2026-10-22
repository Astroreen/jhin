// Rows follow T3 Code's connections settings (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/EnvironmentRow.tsx and ConnectionsSettings.tsx; an agent's
// sign-in follows ProviderAuthenticationSection.tsx.
import type {
  AgentInfo,
  NodeActionProps,
  NodeConnection,
  NodeMemberActionProps,
  NodeTarget,
} from "@jhin/client-api";
import { Badge, Button, Menu, MenuPopup, MenuTrigger, Slot, Spinner, cn, useSlot } from "@jhin/ui";
import { BotIcon, EllipsisIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { MachineIcon } from "../../lib/machine-icon.tsx";
import { useMachineKind } from "../../lib/machines.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { SettingsEmpty, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

/** A node's machine icon, as T3's EnvironmentRow leads with it. */
function NodeMachineIcon({ target, className }: { target: NodeTarget; className: string }) {
  const { machines } = useSettingsServices();
  return <MachineIcon aria-hidden className={className} kind={useMachineKind(machines, target)} />;
}

function StateDot({ state }: { state: NodeConnection["state"] }) {
  return (
    <span
      aria-label={`Connection ${state}`}
      className="absolute -right-1 -bottom-1 flex size-3 shrink-0 items-center justify-center rounded-full bg-background"
      role="img"
    >
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

/**
 * Signing an agent's account in and out (providers.md D1152), T3's
 * ProviderAuthenticationSection: "Sign in" (else "Change account", "Retry sign-in"), the device
 * code to enter, "Cancel", and "Sign out" after a confirmation.
 */
function AgentSignIn(props: {
  target: NodeTarget;
  agent: AgentInfo;
  nodeLabel: string;
  onChanged(): void;
}) {
  const { threads, dialogs, toasts } = useSettingsServices();
  const { agent, target } = props;
  const [flow, setFlow] = useState<{ flowId: string; url: string; userCode?: string }>();
  const [phase, setPhase] = useState<"idle" | "failed" | "cancelled">("idle");
  const [busy, setBusy] = useState(false);
  const methods = agent.signIn ?? [];
  // Only once the agent said whether it is signed in: one that does not even start (T3 needs
  // the provider installed) has nothing to sign in yet.
  if (methods.length === 0 || (agent.signedIn === undefined && flow === undefined)) return null;
  const fail = (failure: unknown) => {
    setPhase("failed");
    toasts?.show({
      type: "error",
      title: "Sign-in failed",
      description: (failure as Error).message,
    });
  };
  const start = async () => {
    setBusy(true);
    try {
      // A device code works wherever the browser is; Codex's browser login only on the node.
      const method = methods.includes("device-code") ? "device-code" : methods[0];
      const started = await threads.call<{ flowId: string; url: string; userCode?: string }>(
        target,
        "agents.sign-in.start",
        { agentId: agent.agentId, method },
      );
      setFlow(started);
      if (started.userCode === undefined) window.open(started.url, "_blank", "noopener");
      const ended = await threads.call<{ success: boolean; error?: string }>(
        target,
        "agents.sign-in.wait",
        { agentId: agent.agentId, flowId: started.flowId },
      );
      setFlow(undefined);
      if (ended.success) {
        setPhase("idle");
        props.onChanged();
      } else if (ended.error === "Sign-in cancelled.") setPhase("cancelled");
      else fail(new Error(ended.error ?? "The sign-in did not finish."));
    } catch (failure) {
      setFlow(undefined);
      fail(failure);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () =>
    flow === undefined
      ? undefined
      : void threads
          .call(target, "agents.sign-in.cancel", { agentId: agent.agentId, flowId: flow.flowId })
          .catch(fail);
  const signOut = async () => {
    const confirmed =
      dialogs === undefined ||
      (await dialogs.confirm({
        title: `Sign out of ${agent.name}?`,
        description: `Sign out of ${agent.name} on ${props.nodeLabel}? This stops running threads that share this sign-in. Thread history is kept.`,
        confirmLabel: "Sign out",
        variant: "destructive",
      }));
    if (!confirmed) return;
    setBusy(true);
    try {
      await threads.call(target, "agents.sign-out", { agentId: agent.agentId });
      props.onChanged();
    } catch (failure) {
      toasts?.show({
        type: "error",
        title: "Sign-out failed",
        description: (failure as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ms-auto flex shrink-0 flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        {flow !== undefined ? (
          <Button aria-label="Cancel sign-in" onClick={cancel} size="xs" variant="ghost-muted">
            Cancel
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => void start()} size="xs" variant="outline">
            {agent.signedIn === true
              ? "Change account"
              : phase === "failed" || phase === "cancelled"
                ? "Retry sign-in"
                : "Sign in"}
          </Button>
        )}
        {flow === undefined && agent.signedIn === true ? (
          <Button disabled={busy} onClick={() => void signOut()} size="xs" variant="ghost">
            Sign out
          </Button>
        ) : null}
      </span>
      {flow?.userCode === undefined ? null : (
        <span className="text-xs text-muted-foreground">
          Enter code <code className="select-all font-mono text-foreground">{flow.userCode}</code>{" "}
          in{" "}
          <a className="underline" href={flow.url} rel="noopener noreferrer" target="_blank">
            your browser
          </a>
          .
        </span>
      )}
    </span>
  );
}

function Agents({ target, nodeLabel }: { target: NodeTarget; nodeLabel: string }) {
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
          <span className="shrink-0 font-medium text-foreground/90">{agent.name}</span>
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
          <AgentSignIn agent={agent} nodeLabel={nodeLabel} onChanged={load} target={target} />
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
  // No menu without items: the machines plugin, which gives the Icon submenu, is optional.
  const hasActions = useSlot("node.member.actions").length > 0;
  const members = useMeshMembers(mesh, connection.id) ?? [];
  const others = members.filter((member) => !member.self);
  if (others.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground/80 uppercase">Its mesh</span>
      {others.map((member) => (
        <div className="flex items-center gap-2 text-xs" key={member.nodeId}>
          <NodeMachineIcon
            className="size-3.5 text-icon-muted"
            target={{ node: connection.id, remote: member.nodeId }}
          />
          <span className="font-medium">{member.name}</span>
          <span className={member.reachable ? "text-success-foreground" : "text-muted-foreground"}>
            {member.reachable ? "reachable" : "unreachable"}
          </span>
          {/* T3 gives every saved environment its menu; a member's is the `node.member.actions` slot. */}
          {hasActions ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label={`More actions for ${member.name}`}
                    className="ms-auto"
                    size="icon-xs"
                    variant="ghost-muted"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <Slot
                  name="node.member.actions"
                  props={{ connection, member } satisfies NodeMemberActionProps}
                />
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function NodesSection() {
  const { connections, navigation } = useSettingsServices();
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
          <div className="relative mt-0.5">
            <NodeMachineIcon className="size-4 text-muted-foreground" target={{ node: node.id }} />
            <StateDot state={node.state} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{node.label}</p>
            <div className="truncate text-xs text-muted-foreground">
              {node.url} · {node.state}
            </div>
            {node.state === "open" ? (
              <>
                <Agents nodeLabel={node.label} target={{ node: node.id }} />
                <MeshMembers connection={node} />
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* T3's "More actions" menu of an environment: here the `node.actions` slot. */}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label={`More actions for ${node.label}`}
                    size="icon-xs"
                    variant="ghost-muted"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <Slot name="node.actions" props={{ connection: node } satisfies NodeActionProps} />
              </MenuPopup>
            </Menu>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}
