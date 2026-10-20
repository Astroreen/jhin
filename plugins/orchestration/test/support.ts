import * as Fs from "node:fs";

import {
  AGENT_REGISTRY_CAPABILITY,
  type AgentItem,
  type AgentRegistry,
  type AgentRuntime,
  type RuntimeMode,
  type TurnRequest,
} from "@jhin/agent-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { testManifest, type TestPlugin } from "@jhin/testing";

import { node as threadsNode, watch } from "../../threads/test/support.ts";
import orchestration from "../src/index.ts";

export { watch };

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;
export const orchestrationPlugin: TestPlugin = { manifest, definition: orchestration };

/** A runtime registered through agent.registry@1 that answers with `answer(request)`. */
export function scriptedRuntime(
  agentId: string,
  answer: (request: TurnRequest) => string,
  options: { runtimeModes?: RuntimeMode[]; available?: boolean; message?: string } = {},
): TestPlugin {
  const runtime: AgentRuntime = {
    agentId,
    name: agentId,
    models: [
      { id: "small", name: "Small" },
      { id: "large", name: "Large" },
    ],
    runtimeModes: options.runtimeModes ?? ["approval-required", "auto-accept-edits", "full-access"],
    interactionModes: ["default", "plan"],
    status: async () => ({
      available: options.available ?? true,
      ...(options.message === undefined ? {} : { message: options.message }),
    }),
    startTurn(request) {
      async function* items(): AsyncGenerator<AgentItem> {
        const text = answer(request);
        yield { kind: "message.completed", itemId: `${request.turnId}:1`, text };
      }
      return { items: items(), interrupt() {} };
    },
  };
  return {
    manifest: testManifest(`test.${agentId}`, {
      side: "server",
      requires: { [AGENT_REGISTRY_CAPABILITY]: "^1" },
    }),
    definition: definePlugin({
      activate(context) {
        context.subscriptions.add(
          context.services.get<AgentRegistry>(AGENT_REGISTRY_CAPABILITY).register(runtime),
        );
      },
    }),
  };
}

/** A node with threads, the fake agent and orchestration (plus `plugins`). */
export function node(options: Parameters<typeof threadsNode>[0] = {}) {
  return threadsNode({
    ...options,
    plugins: [orchestrationPlugin, ...(options.plugins ?? [])],
  });
}

export interface TaskView {
  taskId: string;
  parentThreadId: string;
  childThreadId: string;
  childTurnId: string | null;
  title: string;
  status: string;
  workState: string;
  hasPendingQuestion: boolean;
  hasPendingChildRuns: boolean;
  waitTimedOut: boolean;
  agentId: string;
  model: string | null;
  runtimeMode: string;
  interactionMode: string;
  summary: string | null;
  delivery: string;
  workflowId?: string;
}

/** Follows the `orchestration` stream: `task(id, test)` resolves with the first record `test` accepts. */
export function orchestrationFeed(client: RpcClient) {
  const feed = watch(client, "stream:orchestration");
  const payload = (event: StoredEvent) => event.payload as Record<string, unknown>;
  return {
    events: feed.events,
    task: (taskId: string, test: (task: Record<string, unknown>) => boolean) =>
      feed
        .untilMatch(
          (event) =>
            event.type === "orchestration.task.updated" &&
            payload(event).taskId === taskId &&
            test(payload(event)),
        )
        .then(payload),
    workflow: (workflowId: string, test: (workflow: Record<string, unknown>) => boolean) =>
      feed
        .untilMatch(
          (event) =>
            event.type === "orchestration.workflow.updated" &&
            payload(event).workflowId === workflowId &&
            test(payload(event)),
        )
        .then(payload),
  };
}

/** A thread to delegate from. */
export async function parentThread(client: RpcClient, settings: Record<string, unknown> = {}) {
  return client.call<{ id: string; projectId: string; title: string }>("threads.create", {
    title: "Parent",
    ...settings,
  });
}
