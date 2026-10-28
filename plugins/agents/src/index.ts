// Defined agents (docs/plans/agents.md, A1: D602–D614). Each is registered in
// agent.registry@1 as a runtime of its own id that hands its turns to the
// runtime it names, so threads, turns and agents.list need no second path.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
  AGENTS_CONFIG_SECTION,
  AGENTS_STREAM,
  AgentCommands,
  AgentEvents,
  AgentsConfig,
  ThreadEvents,
  agentAddress,
  agentKnowledgeDir,
  agentStatusOf,
  parseAgentAddress,
  type AgentDefinition,
  type AgentGeneration,
  type AgentRecord,
  type AgentRegistry,
  type AgentRuntime,
  type AgentStatus,
  type AgentTurn,
  type TurnRequest,
  type TurnStatus,
} from "@jhin/agent-api";
import { HOST_IDENTITY_CAPABILITY, type HostIdentity } from "@jhin/host-api";
import { definePlugin, type Disposable, describePermissions } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";

import { AgentsError } from "./errors.ts";
import { registerMessaging } from "./messaging.ts";

const NAMESPACE = "jhin.agents";
/** How much inherited knowledge goes in front of a generation's first message (D607). */
export const MAX_KNOWLEDGE_CHARS = 64_000;
const SCRATCH_PROJECT = "scratch";

/** What the plugin keeps of an agent in `storage.kv` (`agent/<id>`). */
interface Stored {
  generations: AgentGeneration[];
  /** The definition the `agents` stream last reported; absent once it was removed. */
  recorded?: AgentDefinition;
  stoppedAt?: string;
}

interface ProjectInfo {
  readonly id: string;
  readonly path: string;
  readonly scratch: boolean;
}

interface ThreadInfo {
  readonly title: string;
  readonly lastTurn?: { readonly status: TurnStatus };
}

const titleOf = (agentId: string, definition: AgentDefinition | undefined) =>
  definition?.title ?? agentId;

/** JSON with sorted keys, so two definitions compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expandHome(path: string): string {
  if (path === "~") return Os.homedir();
  return path.startsWith("~/") ? Path.join(Os.homedir(), path.slice(2)) : path;
}

/**
 * The inherited knowledge put in front of a generation's first message
 * (D607): the `*.md` files directly in `dir`, by name, while the whole text
 * (headings included) stays within MAX_KNOWLEDGE_CHARS; the files past that
 * are named only. A file whose size alone is past the budget is not read.
 */
export function knowledgePreface(dir: string): string | undefined {
  let names: string[];
  try {
    names = Fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return undefined;
  }
  const head = `Your inherited knowledge, from ${dir}:\n\n`;
  const tail = "\n\n---\n\nThe message follows.\n\n";
  let budget = MAX_KNOWLEDGE_CHARS - head.length - tail.length;
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const path = Path.join(dir, name);
    let text: string;
    try {
      // UTF-8 takes at most 4 bytes a character: past that, the file cannot fit.
      if (Fs.statSync(path).size > budget * 4) {
        skipped.push(name);
        continue;
      }
      text = Fs.readFileSync(path, "utf8").trim();
    } catch {
      // The agent writes the folder itself: a file gone or locked meanwhile is left out.
      continue;
    }
    if (text === "") continue;
    const part = `${parts.length === 0 ? "" : "\n\n"}## ${name}\n\n${text}`;
    if (part.length > budget) {
      skipped.push(name);
      continue;
    }
    budget -= part.length;
    parts.push(part);
  }
  if (parts.length === 0 && skipped.length === 0) return undefined;
  const note =
    skipped.length === 0
      ? ""
      : `${parts.length === 0 ? "" : "\n\n"}Not shown here, too long: ${skipped.join(", ")}. Read them in that folder.`;
  return `${head}${parts.join("")}${note}${tail}`;
}

/** How long a generation's first turn waits for its lore brief (D1392). */
export const LORE_BRIEF_TIMEOUT_MS = 30_000;

/**
 * A turn whose runtime starts once `before` resolves: what a generation's
 * first turn needs, since its lore brief is a command (A4, D671). An
 * interrupt before then ends the turn at once and the runtime never starts;
 * a steer before then is refused, so the message gets a turn of its own
 * (threads asks the runtime's `steering`, not this turn, whether to steer).
 */
export function deferredTurn<T>(before: Promise<T>, begin: (value: T) => AgentTurn): AgentTurn {
  let inner: AgentTurn | undefined;
  let interrupted = false;
  let stop!: () => void;
  const stopped = new Promise<undefined>((resolve) => (stop = () => resolve(undefined)));
  const ready = before.then((value) => {
    if (interrupted) return undefined;
    inner = begin(value);
    return inner;
  });
  // A turn that fails to start fails its items; nobody reading them is no unhandled rejection.
  ready.catch(() => undefined);
  return {
    items: (async function* () {
      const turn = await Promise.race([ready, stopped]);
      if (turn === undefined) return;
      yield* turn.items;
    })(),
    interrupt() {
      interrupted = true;
      stop();
      inner?.interrupt();
    },
    respond(requestId, response) {
      // Only the runtime's turn opens requests, so it exists by now.
      inner?.respond?.(requestId, response);
    },
    steer(input) {
      if (inner?.steer === undefined) throw new Error("The turn is not running yet");
      inner.steer(input);
    },
  };
}

/** What a generation is told besides the conversation (D605). */
export function agentInstructions(agent: {
  readonly title: string;
  readonly address: string;
  readonly role: string;
  readonly instructions?: string | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly knowledgeDir: string;
  readonly generation?: number | undefined;
}): string {
  return [
    `You are ${agent.title}, a persistent agent of this Jhin node, at ${agent.address}.`,
    ...(agent.generation === undefined
      ? []
      : [
          `This thread is your generation ${agent.generation}. Earlier generations' threads stay readable; you start from your inherited knowledge, not from their transcripts.`,
        ]),
    `Your role: ${agent.role}`,
    ...(agent.skills === undefined || agent.skills.length === 0
      ? []
      : [`Your skills: ${agent.skills.join(", ")}.`]),
    ...(agent.instructions === undefined || agent.instructions.trim() === ""
      ? []
      : ["", agent.instructions.trim(), ""]),
    `Your inherited knowledge is in ${agent.knowledgeDir}: Markdown files your earlier generations wrote. Keep it current: write there what the next generation of you should know, one topic per file, and correct what turned out wrong.`,
  ].join("\n");
}

export default definePlugin({
  async activate(context) {
    context.config.define(AGENTS_CONFIG_SECTION, AgentsConfig);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const registry = context.services.get<AgentRegistry>(AGENT_REGISTRY_CAPABILITY);
    const { nodeId } = context.services.get<HostIdentity>(HOST_IDENTITY_CAPABILITY);
    const now = () => new Date().toISOString();
    const run = <T>(name: string, input: unknown) =>
      context.commands.execute(name, input) as Promise<T>;

    /**
     * The lore brief of the agent's home project and its own lore, from
     * `lore.brief` (jhin.context, A4, D671), or nothing on a node without it.
     */
    const loreBrief = async (agentId: string): Promise<string> => {
      const home = homes.get(agentId);
      if (home === undefined) return "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The brief reads local files, so it ends; a bound keeps a stuck one
        // from holding the first turn for good (D1392). One that comes after
        // the bound is ignored.
        const brief = await Promise.race([
          run<{ markdown: string; stories: string[] }>("lore.brief", {
            projectId: home.id,
            agent: agentId,
            reason: "start",
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error(`no lore brief within ${LORE_BRIEF_TIMEOUT_MS / 1000} seconds`)),
              LORE_BRIEF_TIMEOUT_MS,
            );
          }),
        ]);
        return brief.stories.length === 0 ? "" : `${brief.markdown}\n---\n\n`;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "COMMAND_NOT_FOUND") {
          context.log.warn("no lore brief for a generation", { agentId, error: String(error) });
        }
        return "";
      } finally {
        clearTimeout(timer);
      }
    };

    // --- Definitions and what is stored ---------------------------------------
    /** The last valid section: a broken file edit keeps the agents as they were. */
    let lastGood: Record<string, AgentDefinition> = {};
    const definitions = (): Record<string, AgentDefinition> => {
      try {
        lastGood = context.config.get<AgentsConfig>(AGENTS_CONFIG_SECTION).agents;
      } catch (error) {
        context.log.warn("jhin.agents is invalid; keeping the agents as they were", {
          error: String(error),
        });
      }
      return lastGood;
    };
    /** The stored state of every agent the plugin knows, read once and written through. */
    const stored = new Map<string, Stored>();
    for (const entry of await kv.list(NAMESPACE, { prefix: "agent/" })) {
      stored.set(entry.key.slice("agent/".length), entry.value as unknown as Stored);
    }
    const storedOf = (agentId: string): Stored => stored.get(agentId) ?? { generations: [] };
    const save = async (agentId: string, value: Stored) => {
      await kv.set(NAMESPACE, `agent/${agentId}`, value as unknown as Json);
      stored.set(agentId, value);
    };
    /** Home folders by agent, as last resolved: the runtime side reads them synchronously. */
    const homes = new Map<string, ProjectInfo>();

    /** A queue running its tasks one at a time. */
    const queue = () => {
      let tail: Promise<unknown> = Promise.resolve();
      return <T>(task: () => Promise<T>): Promise<T> => {
        const result = tail.then(task, task);
        tail = result.catch(() => undefined);
        return result;
      };
    };
    /** Changes of stored state, so no two read and write the same record. */
    const serial = queue();
    /** Changes of definitions: a check and its write are one step (they wait for `serial`). */
    const definitionWrites = queue();

    const projects = () => run<ProjectInfo[]>("projects.list", {});
    /** The home project of a definition: by id, else by path; the scratch project when unset (D604). */
    const homeOf = async (
      definition: AgentDefinition,
      listed?: readonly ProjectInfo[],
    ): Promise<ProjectInfo | undefined> => {
      const all = listed ?? (await projects());
      const wanted = definition.project;
      if (wanted === undefined) return all.find((project) => project.id === SCRATCH_PROJECT);
      const byId = all.find((project) => project.id === wanted);
      if (byId !== undefined) return byId;
      const path = Path.resolve(expandHome(wanted));
      return all.find((project) => Path.resolve(project.path) === path);
    };

    const hasCommand = (name: string) => context.commands.list().some((item) => item.name === name);
    /** The layers that define each agent, the highest last; empty without host.config.get. */
    const layersOf = async (): Promise<Record<string, string[]>> => {
      if (!hasCommand("host.config.get")) return {};
      const { layers } = await run<{ layers: Record<string, unknown> }>("host.config.get", {
        section: AGENTS_CONFIG_SECTION,
      });
      const found: Record<string, string[]> = {};
      for (const layer of ["node", "project"]) {
        const agents = (layers[layer] as { agents?: unknown } | undefined)?.agents;
        if (agents === null || typeof agents !== "object") continue;
        for (const agentId of Object.keys(agents)) (found[agentId] ??= []).push(layer);
      }
      return found;
    };

    /** What building several records shares, read once: the layers and the projects. */
    interface Lookup {
      readonly layers: Record<string, string[]>;
      readonly projects: readonly ProjectInfo[];
    }
    const lookup = async (): Promise<Lookup> => ({
      layers: await layersOf(),
      projects: await projects(),
    });

    async function recordOf(
      agentId: string,
      definition: AgentDefinition,
      shared?: Lookup,
    ): Promise<AgentRecord> {
      const home = await homeOf(definition, shared?.projects);
      if (home === undefined) homes.delete(agentId);
      else homes.set(agentId, home);
      const state = storedOf(agentId);
      const layer = (shared?.layers ?? (await layersOf()))[agentId]?.at(-1);
      return {
        agentId,
        address: agentAddress(nodeId, agentId),
        kind: "defined",
        title: titleOf(agentId, definition),
        role: definition.role,
        runtimeId: definition.runtime,
        ...(definition.model === undefined ? {} : { model: definition.model }),
        ...(definition.runtimeMode === undefined ? {} : { runtimeMode: definition.runtimeMode }),
        ...(definition.interactionMode === undefined
          ? {}
          : { interactionMode: definition.interactionMode }),
        ...(definition.instructions === undefined ? {} : { instructions: definition.instructions }),
        skills: [...(definition.skills ?? [])],
        ...(definition.userSettings === undefined ? {} : { userSettings: definition.userSettings }),
        ...(home === undefined
          ? {}
          : {
              projectId: home.id,
              knowledgeDir: Path.join(home.path, agentKnowledgeDir(agentId)),
            }),
        generations: [...state.generations],
        ...(layer === undefined ? {} : { layer }),
        ...(state.stoppedAt === undefined ? {} : { stoppedAt: state.stoppedAt }),
      };
    }

    const append = (type: string, payload: unknown) =>
      log.append(AGENTS_STREAM, [{ type, payload: payload as Json }]);

    // --- Agents as runtimes (D602) ----------------------------------------------
    const registrations = new Map<string, Disposable>();
    /** The runtime a defined agent runs on; never another defined agent. */
    const runtimeOf = (definition: AgentDefinition | undefined): AgentRuntime | undefined => {
      if (definition === undefined) return undefined;
      const runtime = registry.get(definition.runtime);
      return runtime?.runtimeId === undefined ? runtime : undefined;
    };

    function agentRuntime(agentId: string): AgentRuntime {
      const definition = () => definitions()[agentId];
      // The getters read the definition at each use, so a changed one counts at once;
      // a getter that has nothing returns undefined, which readers take as absent.
      const agent = {
        agentId,
        get runtimeId() {
          return definition()?.runtime ?? agentId;
        },
        get name() {
          return titleOf(agentId, definition());
        },
        get role() {
          return definition()?.role;
        },
        get models() {
          return runtimeOf(definition())?.models;
        },
        get defaultModel() {
          return definition()?.model ?? runtimeOf(definition())?.defaultModel;
        },
        get runtimeModes() {
          return runtimeOf(definition())?.runtimeModes;
        },
        get interactionModes() {
          return runtimeOf(definition())?.interactionModes;
        },
        get steering() {
          return runtimeOf(definition())?.steering;
        },
        async status() {
          const current = definition();
          const runtime = runtimeOf(current);
          if (current === undefined || runtime === undefined) {
            return {
              available: false,
              message: `No runtime ${current?.runtime ?? "?"} on this node`,
            };
          }
          return runtime.status === undefined ? { available: true } : runtime.status();
        },
        startTurn(request: TurnRequest) {
          const current = definition();
          if (current === undefined) {
            throw new AgentsError("AGENT_NOT_FOUND", `No agent ${agentId} on this node`, {
              agentId,
            });
          }
          const state = storedOf(agentId);
          if (state.stoppedAt !== undefined) {
            throw new AgentsError("AGENT_STOPPED", `The agent ${agentId} is stopped`, { agentId });
          }
          const runtime = runtimeOf(current);
          if (runtime === undefined) {
            throw new AgentsError(
              "AGENT_NOT_FOUND",
              `No runtime ${current.runtime} on this node for the agent ${agentId}`,
              { agentId, runtimeId: current.runtime },
            );
          }
          const generation = state.generations.find((item) => item.threadId === request.threadId);
          const knowledgeDir = Path.join(
            homes.get(agentId)?.path ?? request.cwd,
            agentKnowledgeDir(agentId),
          );
          const instructions = agentInstructions({
            title: titleOf(agentId, current),
            address: agentAddress(nodeId, agentId),
            role: current.role,
            instructions: current.instructions,
            skills: current.skills,
            knowledgeDir,
            generation: generation?.number,
          });
          // The first turn of a thread starts from the inherited knowledge (D607).
          const first = !request.history.some((event) => event.type === ThreadEvents.turnStarted);
          const preface = first ? knowledgePreface(knowledgeDir) : undefined;
          const model = request.model ?? current.model;
          const runtimeMode = request.runtimeMode ?? current.runtimeMode;
          const interactionMode = request.interactionMode ?? current.interactionMode;
          const begin = (lore: string) =>
            runtime.startTurn({
              ...request,
              input: { ...request.input, text: `${lore}${preface ?? ""}${request.input.text}` },
              ...(model === undefined ? {} : { model }),
              ...(runtimeMode === undefined ? {} : { runtimeMode }),
              ...(interactionMode === undefined ? {} : { interactionMode }),
              instructions:
                request.instructions === undefined
                  ? instructions
                  : `${instructions}\n\n${request.instructions}`,
              // The node user's own settings only when the owner chose them (D1561).
              userSettings: current.userSettings ?? false,
            });
          // A generation's first turn also starts from the lore (A4, D671).
          return first ? deferredTurn(loreBrief(agentId), begin) : begin("");
        },
      };
      return agent as AgentRuntime;
    }

    const register = (agentId: string) => {
      if (registrations.has(agentId)) return;
      try {
        registrations.set(
          agentId,
          context.subscriptions.add(registry.register(agentRuntime(agentId))),
        );
      } catch (error) {
        context.log.error("could not register a defined agent", { agentId, error: String(error) });
      }
    };
    const unregister = (agentId: string) => {
      registrations.get(agentId)?.dispose();
      registrations.delete(agentId);
    };

    /**
     * Brings the registry and the `agents` stream in line with the section
     * (D604): a definition added, changed or gone, by command or by hand.
     */
    const reconcile = () =>
      serial(async () => {
        const current = definitions();
        const shared = await lookup();
        for (const [agentId, definition] of Object.entries(current)) {
          register(agentId);
          const state = storedOf(agentId);
          if (state.recorded !== undefined && canonical(state.recorded) === canonical(definition)) {
            continue;
          }
          const isNew = state.recorded === undefined;
          await save(agentId, { ...state, recorded: definition });
          await append(
            isNew ? AgentEvents.defined : AgentEvents.updated,
            await recordOf(agentId, definition, shared),
          );
        }
        for (const [agentId, state] of stored) {
          if (Object.hasOwn(current, agentId) || state.recorded === undefined) continue;
          unregister(agentId);
          const { recorded: _recorded, ...rest } = state;
          await save(agentId, rest);
          await append(AgentEvents.removed, { agentId });
        }
      });
    await reconcile();
    context.config.onDidChange(AGENTS_CONFIG_SECTION, () => {
      reconcile().catch((error: unknown) =>
        context.log.error("could not follow a change of jhin.agents", { error: String(error) }),
      );
    });

    // --- Lookups ----------------------------------------------------------------
    /** The id behind an id or an address of this node (D603). */
    const idOf = (ref: string): string => {
      const address = parseAgentAddress(ref);
      if (address === undefined) return ref;
      if (address.nodeId !== nodeId) {
        throw new AgentsError("AGENT_ELSEWHERE", `${ref} is an agent of another node`, {
          nodeId: address.nodeId,
          agentId: address.agentId,
        });
      }
      return address.agentId;
    };
    const definitionOf = (agentId: string): AgentDefinition => {
      const definition = definitions()[agentId];
      if (definition !== undefined) return definition;
      const runtime = registry.get(agentId);
      if (runtime !== undefined && runtime.runtimeId === undefined) {
        throw new AgentsError("AGENT_IS_RUNTIME", `${agentId} is a runtime, not a defined agent`, {
          agentId,
        });
      }
      throw new AgentsError("AGENT_NOT_FOUND", `No agent ${agentId} on this node`, { agentId });
    };
    const threadOf = (threadId: string) =>
      run<{ thread: ThreadInfo }>("threads.get", { threadId }).then(
        ({ thread }) => thread,
        () => undefined,
      );
    async function statusOf(record: AgentRecord): Promise<AgentStatus> {
      if (record.stoppedAt !== undefined) return "stopped";
      if (
        record.projectId === undefined ||
        runtimeOf(definitions()[record.agentId]) === undefined
      ) {
        return "unavailable";
      }
      const current = record.generations.at(-1);
      if (current === undefined) return "idle";
      return agentStatusOf((await threadOf(current.threadId))?.lastTurn);
    }

    // --- Writing definitions (D604) ---------------------------------------------
    /** The config files this node writes, the highest last. */
    const WRITABLE = ["node", "project"] as const;
    type Writable = (typeof WRITABLE)[number];
    const writableLayersOf = async (agentId: string): Promise<Writable[]> => {
      const layers = (await layersOf())[agentId] ?? [];
      return WRITABLE.filter((layer) => layers.includes(layer));
    };

    /**
     * Changes one agent's own entry in one layer's `agents`: `change` gets
     * what that file says of the agent (not the merged definition) and returns
     * the new entry, or `undefined` to remove it.
     */
    async function writeLayer(
      layer: Writable,
      agentId: string,
      change: (own: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
    ): Promise<void> {
      if (!hasCommand("host.config.patch") || !hasCommand("host.config.get")) {
        throw new AgentsError("CONFIG_UNAVAILABLE", "This node cannot change its config");
      }
      const { layers } = await run<{ layers: Record<string, unknown> }>("host.config.get", {
        section: AGENTS_CONFIG_SECTION,
      });
      const existing = (layers[layer] as { agents?: Record<string, unknown> } | undefined)?.agents;
      const agents: Record<string, unknown> = { ...existing };
      const next = change(agents[agentId] as Record<string, unknown> | undefined);
      if (next === undefined) delete agents[agentId];
      else agents[agentId] = next;
      const result = await run<{ applied: boolean }>("host.config.patch", {
        layer,
        section: AGENTS_CONFIG_SECTION,
        values: { agents },
      });
      if (!result.applied) {
        throw new AgentsError("CONFIG_UNAVAILABLE", "A later change of jhin.agents won", {
          layer,
        });
      }
      await reconcile();
    }

    /**
     * Writes several files one by one; a failure says which files were done
     * (`done`) and which failed, as `removedFrom` or `updatedIn` (D604).
     */
    async function eachLayer(
      agentId: string,
      verb: "removed" | "updated",
      layers: readonly Writable[],
      write: (layer: Writable) => Promise<void>,
    ): Promise<Writable[]> {
      const done: Writable[] = [];
      for (const layer of layers) {
        try {
          await write(layer);
        } catch (error) {
          const where = verb === "removed" ? "removedFrom" : "updatedIn";
          throw new AgentsError(
            (error as { code?: string }).code ?? "CONFIG_UNAVAILABLE",
            `The agent ${agentId} was ${verb} in ${done.join(", ") || "no file"} but not in the ${layer} file: ${(error as Error).message}`,
            { agentId, [where]: done, failed: layer },
          );
        }
        done.push(layer);
      }
      return done;
    }

    const stripUndefined = (definition: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(definition).filter(([, value]) => value !== undefined),
      ) as AgentDefinition;

    /** Makes a generation's thread; idempotent, since the thread id is chosen here (D207). */
    const createGeneration = (
      agentId: string,
      definition: AgentDefinition,
      home: ProjectInfo,
      generation: AgentGeneration,
    ) =>
      run("threads.create", {
        threadId: generation.threadId,
        projectId: home.id,
        title: `${titleOf(agentId, definition)} #${generation.number}`,
        agentId,
        // The D741 mark: Threads mode leaves the thread out of its lists.
        generationOf: agentId,
      });

    // A current generation whose thread a crash kept from being made is made
    // now. One the owner deleted stays deleted (`THREAD_EXISTS`).
    for (const [agentId, state] of stored) {
      const current = state.generations.at(-1);
      const definition = definitions()[agentId];
      if (current === undefined || definition === undefined) continue;
      if ((await threadOf(current.threadId)) !== undefined) continue;
      const home = await homeOf(definition);
      if (home === undefined) continue;
      await createGeneration(agentId, definition, home, current).catch((error: unknown) =>
        context.log.warn("could not make a generation's thread", {
          agentId,
          threadId: current.threadId,
          error: String(error),
        }),
      );
    }

    // Messaging between agents and the owner (A2, D621–D629).
    registerMessaging(context, { nodeId, kv, log });

    // --- Commands (D609) --------------------------------------------------------
    const commands = AgentCommands;

    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "agents.read": {
        title: "View agents",
        description: "Read defined agents, their catalog and generations.",
      },
      "agents.write": {
        title: "Manage agents",
        description: "Define, update, stop and resume agents.",
      },
    });
    context.commands.register({
      name: "agents.get",
      description:
        "An agent of this node by id or address: its definition, generations and status; a runtime is the implicit agent of its id",
      ...commands["agents.get"],
      permissions: ["agents.read"],
      handler: async ({ agentId: ref }) => {
        const agentId = idOf(ref);
        const definition = definitions()[agentId];
        if (definition === undefined) {
          const runtime = registry.get(agentId);
          if (runtime === undefined) {
            throw new AgentsError("AGENT_NOT_FOUND", `No agent ${agentId} on this node`, {
              agentId,
            });
          }
          const status = runtime.status === undefined ? undefined : await runtime.status();
          return {
            agentId,
            address: agentAddress(nodeId, agentId),
            kind: "runtime" as const,
            title: runtime.name ?? agentId,
            runtimeId: agentId,
            ...(runtime.defaultModel === undefined ? {} : { model: runtime.defaultModel }),
            skills: [],
            generations: [],
            status: status?.available === false ? ("unavailable" as const) : ("idle" as const),
          };
        }
        const record = await recordOf(agentId, definition);
        return { ...record, status: await statusOf(record) };
      },
    });

    context.commands.register({
      name: "agents.catalog",
      description:
        "Every defined agent of this node, and the head of the `agents` stream they reflect: follow the stream after `head` to keep them current",
      ...commands["agents.catalog"],
      permissions: ["agents.read"],
      handler: async () => {
        // The head first: a change made while the records are read is delivered after it too.
        const head = await log.head(AGENTS_STREAM);
        const shared = await lookup();
        const agents = await Promise.all(
          Object.entries(definitions()).map(([agentId, definition]) =>
            recordOf(agentId, definition, shared),
          ),
        );
        return { head, agents: agents.toSorted((a, b) => a.agentId.localeCompare(b.agentId)) };
      },
    });

    context.commands.register({
      name: "agents.define",
      description:
        "Defines an agent in this node's config (the node file unless `layer` says project): its role, runtime, model, instructions and home project",
      ...commands["agents.define"],
      permissions: ["agents.write"],
      handler: ({ agentId, layer, ...definition }) =>
        definitionWrites(async () => {
          if (definitions()[agentId] !== undefined) {
            throw new AgentsError("AGENT_EXISTS", `An agent ${agentId} is already defined`, {
              agentId,
            });
          }
          if (registry.get(agentId) !== undefined) {
            throw new AgentsError("AGENT_ID_TAKEN", `${agentId} is a runtime's id`, { agentId });
          }
          await writeLayer(layer ?? "node", agentId, () => stripUndefined(definition));
          return recordOf(agentId, definitionOf(agentId));
        }),
    });

    context.commands.register({
      name: "agents.update",
      description:
        "Changes a defined agent's definition where it is defined; `unset` clears optional fields",
      ...commands["agents.update"],
      permissions: ["agents.write"],
      handler: ({ agentId: ref, unset, ...changes }) =>
        definitionWrites(async () => {
          const agentId = idOf(ref);
          definitionOf(agentId);
          const layers = await writableLayersOf(agentId);
          const top = layers.at(-1);
          if (top === undefined) {
            throw new AgentsError(
              "CONFIG_UNAVAILABLE",
              `The agent ${agentId} is not defined in a node or project file`,
              { agentId },
            );
          }
          // Changes go to the highest file that defines the agent, as keys of
          // its own entry, so a lower file's other fields keep applying. A
          // field to clear goes from every file that sets it, highest first,
          // so each step leaves a valid definition.
          const given = stripUndefined(changes) as Record<string, unknown>;
          const cleared = new Set<string>(unset ?? []);
          await eachLayer(agentId, "updated", layers.toReversed(), (layer) =>
            writeLayer(layer, agentId, (own) => {
              const next: Record<string, unknown> = {
                ...own,
                ...(layer === top ? given : {}),
              };
              for (const key of cleared) delete next[key];
              return next;
            }),
          );
          return recordOf(agentId, definitionOf(agentId));
        }),
    });

    context.commands.register({
      name: "agents.remove",
      description:
        "Removes a defined agent's definition from the config files that have it; its generations, their threads and its knowledge stay (D611)",
      ...commands["agents.remove"],
      permissions: ["agents.write"],
      handler: ({ agentId: ref }) =>
        definitionWrites(async () => {
          const agentId = idOf(ref);
          if (definitions()[agentId] === undefined) {
            definitionOf(agentId);
            return { removed: false };
          }
          // Highest first: should a later write fail, the agent is still defined
          // by the files left (a valid definition), and removing again goes on.
          const removedFrom = await eachLayer(
            agentId,
            "removed",
            (await writableLayersOf(agentId)).toReversed(),
            (layer) => writeLayer(layer, agentId, () => undefined),
          );
          if (definitions()[agentId] !== undefined) {
            throw new AgentsError(
              "CONFIG_UNAVAILABLE",
              `The agent ${agentId} is still defined by a layer this node cannot write`,
              { agentId, removedFrom },
            );
          }
          return { removed: true };
        }),
    });

    /**
     * An idle previous generation goes to the Settled shelf (D1397). One that is
     * running or waiting, or any other refusal, is left to the threads' own
     * auto-settle sweep: the rotation stands either way.
     */
    const settlePrevious = async (agentId: string, previous: AgentGeneration) => {
      try {
        if (!context.config.get<AgentsConfig>(AGENTS_CONFIG_SECTION).settlePreviousGeneration) {
          return;
        }
        await run("threads.settle", { threadId: previous.threadId });
      } catch (error) {
        context.log.info("left the previous generation unsettled", {
          agentId,
          generation: previous.number,
          error: String(error),
        });
      }
    };

    context.commands.register({
      name: "agents.rotate",
      description:
        "Starts a new generation of a defined agent: a new thread in its home project, which begins with its inherited knowledge; the previous one stays readable",
      ...commands["agents.rotate"],
      permissions: ["agents.write"],
      handler: ({ agentId: ref, reason }) => {
        const agentId = idOf(ref);
        return serial(async () => {
          const definition = definitionOf(agentId);
          const state = storedOf(agentId);
          if (state.stoppedAt !== undefined) {
            throw new AgentsError("AGENT_STOPPED", `The agent ${agentId} is stopped`, {
              agentId,
            });
          }
          const home = await homeOf(definition);
          if (home === undefined) {
            throw new AgentsError(
              "PROJECT_NOT_FOUND",
              `The home project ${definition.project ?? SCRATCH_PROJECT} of ${agentId} is not on this node`,
              { agentId, project: definition.project },
            );
          }
          homes.set(agentId, home);
          Fs.mkdirSync(Path.join(home.path, agentKnowledgeDir(agentId)), { recursive: true });
          const number = (state.generations.at(-1)?.number ?? 0) + 1;
          const generation: AgentGeneration = {
            number,
            threadId: Crypto.randomUUID(),
            startedAt: now(),
            ...(reason === undefined ? {} : { reason }),
          };
          const previous = state.generations.at(-1);
          // The generation is recorded before its thread exists, under the id the
          // thread will get: a thread is never left outside every generation
          // list, and one a crash kept from being made is made on the next start.
          await save(agentId, { ...state, generations: [...state.generations, generation] });
          try {
            await createGeneration(agentId, definition, home, generation);
          } catch (error) {
            // Made after all (only its answer was lost): the generation stands.
            if ((await threadOf(generation.threadId)) === undefined) {
              await save(agentId, state);
              throw error;
            }
          }
          await append(AgentEvents.generationStarted, {
            agentId,
            generation,
            ...(previous === undefined ? {} : { previous }),
          });
          await append(AgentEvents.updated, await recordOf(agentId, definition));
          if (previous !== undefined) await settlePrevious(agentId, previous);
          return { generation, ...(previous === undefined ? {} : { previous }) };
        });
      },
    });

    context.commands.register({
      name: "agents.generations",
      description: "Every generation of an agent, oldest first, with its thread's title and status",
      ...commands["agents.generations"],
      permissions: ["agents.read"],
      handler: async ({ agentId: ref }) => {
        const agentId = idOf(ref);
        const state = stored.get(agentId);
        // A removed agent's generations stay readable (D611).
        if (state === undefined) definitionOf(agentId);
        const generations = state?.generations ?? [];
        return Promise.all(
          generations.map(async (generation, index) => {
            const thread = await threadOf(generation.threadId);
            return {
              ...generation,
              current: index === generations.length - 1,
              status:
                thread === undefined ? ("unavailable" as const) : agentStatusOf(thread.lastTurn),
              ...(thread === undefined ? {} : { title: thread.title }),
            };
          }),
        );
      },
    });

    context.commands.register({
      name: "agents.stop",
      description:
        "Stops a defined agent: interrupts its current generation's turn, and it takes no new work until resumed",
      ...commands["agents.stop"],
      permissions: ["agents.write"],
      handler: ({ agentId: ref }) => {
        const agentId = idOf(ref);
        return serial(async () => {
          const definition = definitionOf(agentId);
          const state = storedOf(agentId);
          const stoppedAt = state.stoppedAt ?? now();
          if (state.stoppedAt === undefined) {
            await save(agentId, { ...state, stoppedAt });
            await append(AgentEvents.stopped, { agentId, at: stoppedAt });
            await append(AgentEvents.updated, await recordOf(agentId, definition));
          }
          const current = state.generations.at(-1);
          const { interrupted } =
            current === undefined
              ? { interrupted: false }
              : await run<{ interrupted: boolean }>("threads.interrupt", {
                  threadId: current.threadId,
                }).catch(() => ({ interrupted: false }));
          return { stoppedAt, interrupted };
        });
      },
    });

    context.commands.register({
      name: "agents.resume",
      description: "Lets a stopped agent take work again",
      ...commands["agents.resume"],
      permissions: ["agents.write"],
      handler: ({ agentId: ref }) => {
        const agentId = idOf(ref);
        return serial(async () => {
          const definition = definitionOf(agentId);
          const state = storedOf(agentId);
          if (state.stoppedAt === undefined) return { resumed: false };
          const { stoppedAt: _stoppedAt, ...rest } = state;
          await save(agentId, rest);
          await append(AgentEvents.resumed, { agentId, at: now() });
          await append(AgentEvents.updated, await recordOf(agentId, definition));
          return { resumed: true };
        });
      },
    });
  },
});
