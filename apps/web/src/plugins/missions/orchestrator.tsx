// The orchestrator beside the mission view (docs/plans/agents.md, C2: D1086–D1090),
// a chunk of its own (D440): loaded once a mission shows.
import {
  ORCHESTRATION_STREAM,
  OrchestrationEvents,
  applyWorkflowPatch,
  type AgentRecord,
  type WorkflowPatch,
} from "@jhin/agent-api";
import type { Connections, ThreadsCatalog } from "@jhin/client-api";
import { missionProgress } from "@jhin/missions-api";
import type { Disposable } from "@jhin/sdk";
import {
  Badge,
  Button,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  type Dialogs,
} from "@jhin/ui";
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { useDirectory } from "./directory.ts";
import { DirectoryNotices } from "./notice.tsx";
import {
  assigneeLabel,
  runLabel,
  waitsFor,
  type MissionAsideProps,
  type OrchestratorRun,
} from "./route.ts";

export interface OrchestratorServices {
  readonly connections: Connections;
  readonly threads: ThreadsCatalog;
  readonly dialogs: Dialogs | undefined;
}

type RunView =
  | { readonly status: "loading" | "unavailable" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "ready"; readonly run: OrchestratorRun | null };

const UNAVAILABLE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

const runOf = (record: OrchestratorRun): OrchestratorRun => ({
  workflowId: record.workflowId,
  parentThreadId: record.parentThreadId,
  ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
  status: record.status,
  // A record is read as it comes; a missing list is none.
  logs: Array.isArray(record.logs) ? record.logs.slice(-5) : [],
  updatedAt: record.updatedAt,
  ...(record.currentPhase === undefined ? {} : { currentPhase: record.currentPhase }),
  ...(record.result === undefined ? {} : { result: record.result }),
  ...(record.error === undefined ? {} : { error: record.error }),
});

/**
 * A mission's run (D1086): `missions.orchestration`, then the node's
 * `orchestration` stream after the head it reflects. A run of the mission
 * started elsewhere (the lead orchestrating again) is read afresh when its
 * first record comes by.
 */
function useMissionRun(connections: Connections, connection: string, missionId: string) {
  const nodes = useExternal(connections, connections.list);
  const node = nodes.find((item) => item.id === connection);
  const client = node?.state === "open" ? node.client : undefined;
  const [view, setView] = useState<{ key: string; view: RunView }>();
  const [round, setRound] = useState(0);
  // A reload keeps showing the last answer until the new one comes: no flash.
  const key = `${connection}|${missionId}`;
  useEffect(() => {
    if (client === undefined) return;
    let stopped = false;
    let subscription: Disposable | undefined;
    const set = (next: RunView) => !stopped && setView({ key, view: next });
    const failed = (error: unknown) => {
      const code = String((error as { code?: unknown } | null)?.code);
      set(
        UNAVAILABLE.has(code)
          ? { status: "unavailable" }
          : { status: "error", error: error instanceof Error ? error.message : String(error) },
      );
    };
    void client
      .call<{ head: number; run: OrchestratorRun | null }>("missions.orchestration", {
        missionId,
      })
      .then((answer) => {
        if (stopped) return;
        let run = answer.run;
        const seen = new Set(run === null ? [] : [run.workflowId]);
        set({ status: "ready", run });
        subscription = client.subscribe(
          ORCHESTRATION_STREAM,
          { after: answer.head, onError: failed },
          (event) => {
            if (stopped) return;
            if (event.type === OrchestrationEvents.workflowPatched) {
              // What changed in a running run (D1504): folded into the one shown.
              const patch = event.payload as unknown as WorkflowPatch;
              if (run !== null && patch.workflowId === run.workflowId) {
                run = runOf(applyWorkflowPatch(run, patch));
                set({ status: "ready", run });
              }
              return;
            }
            if (event.type === OrchestrationEvents.workflowRemoved) {
              // A pruned run is no run to show (D1503).
              const { workflowId } = event.payload as { workflowId?: string };
              if (run !== null && workflowId === run.workflowId) {
                run = null;
                set({ status: "ready", run });
              }
              return;
            }
            if (event.type !== OrchestrationEvents.workflowUpdated) return;
            const record = event.payload as unknown as OrchestratorRun & { name?: string };
            if (record.workflowId === run?.workflowId) {
              run = runOf(record);
              set({ status: "ready", run });
            } else if (record.name === "mission" && !seen.has(record.workflowId)) {
              // A new mission run, perhaps of this mission: ask which it is.
              seen.add(record.workflowId);
              setRound((value) => value + 1);
            }
          },
        );
        if (stopped) subscription.dispose();
      })
      .catch(failed);
    return () => {
      stopped = true;
      subscription?.dispose();
    };
  }, [client, key, round]);
  return {
    view: view?.key === key ? view.view : ({ status: "loading" } as RunView),
    reload: () => setRound((value) => value + 1),
  };
}

/** The agent ids that lead a team on the node (`teams.list`), best effort: none without teams. */
function useTeamLeads(threads: ThreadsCatalog, target: MissionAsideProps["target"]) {
  const [leads, setLeads] = useState<ReadonlySet<string>>(new Set());
  const key = `${target.node}|${target.remote ?? ""}`;
  useEffect(() => {
    let current = true;
    threads
      .call<{ teams: { members: { agentId: string; lead: boolean }[] }[] }>(
        target,
        "teams.list",
        {},
      )
      .then(
        ({ teams }) =>
          current &&
          setLeads(
            new Set(
              teams.flatMap((team) =>
                team.members.filter((member) => member.lead).map((member) => member.agentId),
              ),
            ),
          ),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [threads, key]);
  return leads;
}

/** Agents that can run it: a thread is needed (D706), so those with a generation. */
const leadsOf = (agents: readonly AgentRecord[]) =>
  agents.filter((agent) => agent.generations.length > 0);

const currentThread = (agent: AgentRecord) => agent.generations.at(-1)?.threadId;

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const RUN_VARIANT: Readonly<Record<string, "info" | "warning" | "secondary" | "outline">> = {
  running: "info",
  completed: "warning",
  failed: "warning",
  stopped: "outline",
};

export function OrchestratorPanel(props: MissionAsideProps & { services: OrchestratorServices }) {
  const { target, mission, slices, titles, services } = props;
  const { view, reload } = useMissionRun(services.connections, target.node, mission.id);
  const directory = useDirectory(services.threads, target);
  const leads = leadsOf(directory.agents);
  const teamLeads = useTeamLeads(services.threads, target);
  const run = view.status === "ready" ? view.run : undefined;
  const [chosen, setChosen] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const selectId = useId();
  // An assignee of any node is handed its slice from the mission's node (D1541).
  const progress = useMemo(() => missionProgress(slices), [slices]);
  const byId = useMemo(() => new Map(slices.map((slice) => [slice.id, slice])), [slices]);
  const titleOf = (sliceId: string) => byId.get(sliceId)?.title ?? sliceId;
  const who = (sliceId: string) => assigneeLabel(byId.get(sliceId)?.assignee, titles);
  // The thread of the last run first, then a team's lead, then an agent of the mission's project (D1089).
  const lead =
    leads.find((agent) => agent.agentId === chosen) ??
    leads.find((agent) => run != null && currentThread(agent) === run.parentThreadId) ??
    leads.find((agent) => teamLeads.has(agent.agentId)) ??
    leads.find((agent) => agent.projectId === mission.projectId) ??
    leads[0];
  const closed = mission.status === "done" || mission.status === "dropped";
  const running = run?.status === "running";
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const act = (work: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    work().then(
      () => {
        if (!mounted.current) return;
        setPending(false);
        reload();
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setPending(false);
        setError(failure instanceof Error ? failure.message : String(failure));
        // Part of a stop may have happened: show what the node says now.
        reload();
      },
    );
  };
  const call = (method: string, input: unknown) => services.threads.call(target, method, input);
  /** The node a run started from another node's thread runs on (D1545). */
  const runTarget = (on: OrchestratorRun) =>
    on.nodeId === undefined ? target : { node: target.node, remote: on.nodeId };
  const start = () => {
    const threadId = lead === undefined ? undefined : currentThread(lead);
    if (threadId === undefined) return;
    act(() => call("missions.orchestrate", { missionId: mission.id, parentThreadId: threadId }));
  };
  const pause = () => {
    if (run == null) return;
    act(() =>
      services.threads.call(runTarget(run), "workflows.stop", {
        workflowId: run.workflowId,
        parentThreadId: run.parentThreadId,
      }),
    );
  };
  // Stopping the mission halts its run and the agents at work on it, on every node (D1090, D1544).
  const working = [
    ...new Set(
      slices
        .filter((slice) => slice.status === "active" && slice.assignee?.includes("/agents/"))
        .map((slice) => slice.assignee!)
        // This node's agents already stopped need no stop; another node's are asked.
        .filter(
          (address) =>
            directory.agents.find((agent) => agent.address === address)?.stoppedAt === undefined,
        ),
    ),
  ];
  const stop = async () => {
    const names = working.map((address) => assigneeLabel(address, titles)).join(", ");
    // Stop is confirmed or not done (D1090): without a dialog host it is unavailable.
    if (services.dialogs === undefined) return;
    const confirmed = await services.dialogs.confirm({
      title: `Stop ${mission.title}?`,
      description:
        working.length === 0
          ? "The orchestrator run stops; no slice is handed off until it runs again."
          : `The orchestrator run stops, and so do ${names}: each stops as a whole, in every mission, and takes no new work until resumed on its page.`,
      confirmLabel: "Stop mission",
      variant: "destructive",
    });
    if (!confirmed) return;
    act(async () => {
      const stopped = await call("missions.stop", { missionId: mission.id });
      // A node that refused or cannot be reached is named, so the owner knows who still works.
      const answer = stopped as {
        run?: { nodeId?: string; error?: { message: string } } | null;
        agents?: { address: string; error?: { message: string } }[];
      };
      const failed = [
        ...(answer.run?.error === undefined
          ? []
          : [`The run on node ${answer.run.nodeId ?? "?"}: ${answer.run.error.message}`]),
        ...(answer.agents ?? [])
          .filter((agent) => agent.error !== undefined)
          .map((agent) => `${assigneeLabel(agent.address, titles)}: ${agent.error!.message}`),
      ];
      if (failed.length > 0) throw new Error(failed.join("; "));
    });
  };

  return (
    <aside
      aria-label="Orchestrator"
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-3"
      data-orchestrator={run?.status ?? "none"}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Orchestrator</h2>
        {view.status === "ready" ? (
          <Badge size="sm" variant={RUN_VARIANT[run?.status ?? ""] ?? "secondary"}>
            {runLabel(run)}
          </Badge>
        ) : null}
      </div>
      {view.status === "unavailable" ? (
        <p className="text-xs text-muted-foreground">This node runs no orchestrator.</p>
      ) : view.status === "error" ? (
        <p className="text-xs text-destructive-foreground">Couldn't read the run: {view.error}</p>
      ) : (
        <>
          <DirectoryNotices notices={directory.notices} />
          <Part title="Next">
            {progress.wave === null ? (
              <p className="text-xs text-muted-foreground">
                {progress.total === 0 ? "No slices yet." : "Every slice is done or dropped."}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                <li className="text-muted-foreground">Wave {progress.wave}</li>
                {progress.ready.map((id) => (
                  <li data-next={id} key={id}>
                    <span className="text-foreground">{titleOf(id)}</span>
                    <span className="text-muted-foreground"> → {who(id)}</span>
                  </li>
                ))}
                {progress.working.map((id) => (
                  <li data-working={id} key={id}>
                    <span className="text-foreground">{titleOf(id)}</span>
                    <span className="text-muted-foreground"> · with {who(id)}</span>
                  </li>
                ))}
                {progress.decisions.map((item) => (
                  <li data-decision={item.sliceId} key={item.sliceId}>
                    <span className="text-foreground">{titleOf(item.sliceId)}</span>
                    <span className="text-warning-foreground">
                      {" "}
                      · {waitsForReason(item.reason)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Part>
          {run?.nodeId === undefined ? null : (
            <p className="text-xs text-muted-foreground" data-run-node={run.nodeId}>
              Runs from a thread on node {run.nodeId}.
            </p>
          )}
          <Part title="Waits for">
            <p className="text-xs text-foreground">
              {view.status === "loading" ? "…" : waitsFor(run, progress, titleOf)}
            </p>
          </Part>
          {run == null || run.logs.length === 0 ? null : (
            <Part title="Log">
              <ul className="flex flex-col gap-0.5 font-mono text-2xs text-muted-foreground">
                {run.logs.map((line, index) => (
                  <li className="truncate" key={index} title={line}>
                    {line}
                  </li>
                ))}
              </ul>
            </Part>
          )}
          {closed ? (
            <p className="text-xs text-muted-foreground">The mission is {mission.status}.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {running ? null : leads.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  It runs from an agent's thread: start an agent's first generation.
                </p>
              ) : (
                <label className="flex flex-col gap-1 text-xs" htmlFor={selectId}>
                  <span className="text-muted-foreground">Run from</span>
                  <Select
                    items={Object.fromEntries(leads.map((agent) => [agent.agentId, agent.title]))}
                    onValueChange={(value) => setChosen(String(value))}
                    value={lead?.agentId ?? ""}
                  >
                    <SelectTrigger aria-label="Run from" id={selectId} size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {leads.map((agent) => (
                        <SelectItem key={agent.agentId} value={agent.agentId}>
                          {agent.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
              )}
              <div className="flex flex-wrap gap-1.5">
                {running ? (
                  <Button
                    disabled={pending}
                    onClick={pause}
                    size="compact"
                    type="button"
                    variant="outline"
                  >
                    <PauseIcon aria-hidden />
                    Pause orchestrator
                  </Button>
                ) : (
                  <Button
                    disabled={pending || lead === undefined || view.status !== "ready"}
                    onClick={start}
                    size="compact"
                    type="button"
                  >
                    <PlayIcon aria-hidden />
                    {run == null ? "Start orchestrator" : "Resume orchestrator"}
                  </Button>
                )}
                <Button
                  disabled={
                    pending || services.dialogs === undefined || (!running && working.length === 0)
                  }
                  onClick={() => void stop()}
                  size="compact"
                  type="button"
                  variant="destructive-outline"
                >
                  <SquareIcon aria-hidden />
                  Stop mission
                </Button>
              </div>
            </div>
          )}
          {error === undefined ? null : (
            <p className="text-xs text-destructive-foreground" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </aside>
  );
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  unassigned: "waits for an assignee",
  blocked: "blocked",
  orphaned: "a dependency was dropped",
  elsewhere: "assignee on another node",
};

const waitsForReason = (reason: string) => REASON_TEXT[reason] ?? reason;
