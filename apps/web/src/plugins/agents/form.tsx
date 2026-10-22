// Defining and editing an agent in Civilization mode (docs/plans/agents.md,
// C1: D1065), a chunk of its own (D440): `agents.define` and `agents.update`,
// the same commands the CLI and MCP use.
import type { AgentRecord } from "@jhin/agent-api";
import type { AgentInfo } from "@jhin/client-api";
import {
  Button,
  Input,
  Label,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@jhin/ui";
import { BotIcon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { useCatalog, useExternal } from "../../lib/hooks.ts";
import { defineInput, draftOf, draftProblem, updateInput, type AgentDraft } from "./definition.ts";
import { CIVILIZATION_MODE } from "../../lib/modes.ts";
import { agentRoute } from "./route.ts";
import { storeOf, type AgentsView } from "./views.tsx";

/** The choice that stands for an unset field in a select. */
const UNSET = "-";

function Field(props: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      {props.children(id)}
      {props.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}

/**
 * The form of a new agent (`agentId` undefined) or of one to edit, in
 * `civilization.views` on the panel `agent-definition` (D1065).
 */
export function AgentForm(props: { view: AgentsView; node: string; agentId?: string | undefined }) {
  const { view, node } = props;
  const nodes = useExternal(storeOf(view), storeOf(view).snapshot);
  const state = nodes.get(node);
  const agent =
    props.agentId === undefined
      ? undefined
      : state?.agents.find((item) => item.agentId === props.agentId);
  if (props.agentId !== undefined && agent === undefined) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {state?.status === "loading" || state === undefined
          ? "Loading the agent…"
          : "This node has no defined agent with that id."}
      </p>
    );
  }
  return <Form agent={agent} key={agent?.agentId ?? ""} node={node} view={view} />;
}

function Form(props: { view: AgentsView; node: string; agent: AgentRecord | undefined }) {
  const { view, node, agent } = props;
  const isNew = agent === undefined;
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [runtimes, setRuntimes] = useState<readonly AgentInfo[] | undefined>();
  const catalog = useCatalog(view.threads, { node });
  const projects = catalog?.projects ?? [];

  // The node's runtimes, for the runtime and its models.
  useEffect(() => {
    let current = true;
    view.threads
      .call<AgentInfo[]>({ node }, "agents.list", {})
      .then((list) => {
        if (!current) return;
        const own = list.filter((item) => (item as { kind?: string }).kind !== "defined");
        setRuntimes(own);
        // A new agent runs on the node's default runtime unless the owner picks another.
        setDraft((now) =>
          now.runtime !== ""
            ? now
            : { ...now, runtime: (own.find((item) => item.default) ?? own[0])?.agentId ?? "" },
        );
      })
      .catch(() => current && setRuntimes([]));
    return () => {
      current = false;
    };
  }, [view.threads, node]);

  const runtime = runtimes?.find((item) => item.agentId === draft.runtime);
  const set = (patch: Partial<AgentDraft>) => setDraft((now) => ({ ...now, ...patch }));
  const problem = draftProblem(draft, isNew);
  const back = () =>
    view.navigation.navigate(
      agent === undefined ? { node, mode: CIVILIZATION_MODE } : agentRoute(node, agent.agentId),
    );

  const save = async () => {
    if (problem !== undefined || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      if (isNew) {
        const input = defineInput(draft);
        await view.threads.call({ node }, "agents.define", input);
        view.navigation.navigate(agentRoute(node, input.agentId));
      } else {
        const input = updateInput(agent, draft);
        if (input !== undefined) await view.threads.call({ node }, "agents.update", input);
        back();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const title = isNew ? "New agent" : `Edit ${agent.title}`;
  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="flex items-center gap-2">
          <BotIcon aria-hidden className="size-4 text-muted-foreground" />
          <h1 className="text-base font-semibold">{title}</h1>
        </header>
        <p className="-mt-3 text-sm text-muted-foreground">
          {isNew
            ? "A persistent agent of this node, with an address, a role and generations. It is written to the node's jhin.agents config."
            : `Changes are written where ${agent.agentId} is defined${agent.layer === undefined ? "" : ` (${agent.layer})`}; its next turn runs with them.`}
        </p>
        {isNew ? (
          <Field hint="Lowercase letters, digits and -; part of its address." label="Id">
            {(id) => (
              <Input
                autoFocus
                id={id}
                onChange={(event) => set({ agentId: event.target.value })}
                placeholder="reviewer"
                value={draft.agentId}
              />
            )}
          </Field>
        ) : null}
        <Field hint="How it is shown; its id when empty." label="Title">
          {(id) => (
            <Input
              id={id}
              onChange={(event) => set({ title: event.target.value })}
              value={draft.title}
            />
          )}
        </Field>
        <Field label="Role">
          {(id) => (
            <Input
              id={id}
              onChange={(event) => set({ role: event.target.value })}
              placeholder="Reviews slices against their spec"
              value={draft.role}
            />
          )}
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Runtime">
            {(id) => (
              <Select
                onValueChange={(value) => {
                  if (typeof value === "string" && value !== draft.runtime) {
                    set({ runtime: value, model: "" });
                  }
                }}
                value={draft.runtime === "" ? null : draft.runtime}
              >
                <SelectTrigger aria-label="Runtime" id={id}>
                  <SelectValue>
                    {runtime?.name ??
                      (draft.runtime === ""
                        ? runtimes === undefined
                          ? "Loading runtimes…"
                          : "No runtime"
                        : draft.runtime)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(runtimes ?? []).map((item) => (
                    <SelectItem key={item.agentId} value={item.agentId}>
                      {item.name}
                      {item.available ? "" : " (unavailable)"}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Field>
          <Field label="Model">
            {(id) => (
              <Select
                onValueChange={(value) =>
                  set({ model: value === UNSET || typeof value !== "string" ? "" : value })
                }
                value={draft.model === "" ? UNSET : draft.model}
              >
                <SelectTrigger aria-label="Model" id={id}>
                  <SelectValue>
                    {draft.model === ""
                      ? "The runtime's default"
                      : (runtime?.models.find((model) => model.id === draft.model)?.name ??
                        draft.model)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={UNSET}>The runtime's default</SelectItem>
                  {(runtime?.models ?? []).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Field>
        </div>
        <Field hint="Where its generations run and its knowledge lives." label="Home project">
          {(id) => (
            <Select
              onValueChange={(value) =>
                set({ project: value === UNSET || typeof value !== "string" ? "" : value })
              }
              value={draft.project === "" ? UNSET : draft.project}
            >
              <SelectTrigger aria-label="Home project" id={id}>
                <SelectValue>
                  {draft.project === ""
                    ? "The scratch project"
                    : (projects.find((project) => project.id === draft.project)?.name ??
                      draft.project)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNSET}>The scratch project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </Field>
        <Field hint="Names, separated by commas." label="Skills">
          {(id) => (
            <Input
              id={id}
              onChange={(event) => set({ skills: event.target.value })}
              value={draft.skills}
            />
          )}
        </Field>
        <Field hint="Told to every generation besides its role." label="Instructions">
          {(id) => (
            <Textarea
              id={id}
              onChange={(event) => set({ instructions: event.target.value })}
              rows={8}
              value={draft.instructions}
            />
          )}
        </Field>
        {error === undefined ? null : (
          <p className="text-sm text-destructive-foreground" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button disabled={problem !== undefined || saving} type="submit">
            {isNew ? "Define agent" : "Save"}
          </Button>
          <Button onClick={back} type="button" variant="ghost">
            Cancel
          </Button>
          {problem === undefined ? null : (
            <span className="text-xs text-muted-foreground">{problem}</span>
          )}
        </div>
      </form>
    </section>
  );
}
