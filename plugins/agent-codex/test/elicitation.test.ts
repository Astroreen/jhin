import { afterEach, describe, expect, it } from "vite-plus/test";

import { describeElicitation, toElicitationResponse } from "../src/elicitation.ts";
import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type Step } from "./support.ts";

afterEach(stopAll);

const form = {
  type: "object",
  properties: {
    approve: {
      type: "string",
      enum: ["allow_once", "allow_session"],
      enumNames: ["Allow once", "Allow for this chat"],
    },
  },
  required: ["approve"],
};

const elicit = (params: Record<string, unknown>): Step => ({
  request: "mcpServer/elicitation/request",
  params: { threadId: "$thread", turnId: "$turn", serverName: "codex_apps", ...params },
});

describe("jhin.agent-codex: MCP elicitations (D1146)", () => {
  it("asks for an app's access and answers Codex with the chosen persistence", async () => {
    const fake = fakeCodex({
      turns: [
        [
          elicit({ message: "Allow ChatGPT to use GitHub?", mode: "form", requestedSchema: form }),
          // A URL to open is declined without asking: Jhin cannot follow it for Codex.
          elicit({
            message: "Sign in to Linear",
            mode: "url",
            url: "https://linear.app/x",
            elicitationId: "e-1",
          }),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const opened = until(client, thread.id, "agent.request.opened");
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "open my PRs" });
    const [request] = payloads(await opened, "agent.request.opened");
    expect(request!["request"]).toEqual({
      kind: "approval",
      tool: {
        name: "mcpElicitation",
        kind: "mcp",
        title: "GitHub",
        detail: "Allow ChatGPT to use GitHub?",
      },
      access: { app: "GitHub" },
      decisions: ["cancel", "decline", "accept-for-session", "accept"],
    });
    await client.call("threads.respond", {
      threadId: thread.id,
      requestId: request!["requestId"],
      response: { kind: "approval", decision: "accept-for-session" },
    });
    const events = await done;
    expect(payloads(events, "agent.request.opened")).toHaveLength(1);
    expect(fake.answers()).toEqual([
      { action: "accept", _meta: { persist: "session" }, content: { approve: "allow_session" } },
      { action: "decline" },
    ]);
  });

  it("follows T3's rules for the app's name, the decisions and the answer", () => {
    const plain = { serverName: "files", message: "Read ~/notes?" };
    expect(describeElicitation(plain)).toEqual({
      appName: "files",
      decisions: ["cancel", "decline", "accept"],
    });
    expect(toElicitationResponse(plain, "accept")).toEqual({ action: "accept" });
    expect(toElicitationResponse(plain, "cancel")).toEqual({ action: "cancel" });
    // The app named in its metadata, a session allowance it offers, with the form's label.
    expect(
      describeElicitation({
        serverName: "codex_apps",
        message: "Use Drive?",
        _meta: { connector_name: "Google Drive", persist: ["session"] },
        requestedSchema: form,
      }),
    ).toEqual({
      appName: "Google Drive",
      decisions: ["cancel", "decline", "accept-for-session", "accept"],
      sessionLabel: "Allow for this chat",
    });
    // A required field Jhin cannot fill declines.
    expect(
      toElicitationResponse(
        {
          serverName: "s",
          message: "Name?",
          requestedSchema: { properties: { name: { type: "string" } }, required: ["name"] },
        },
        "accept",
      ),
    ).toEqual({ action: "decline" });
  });
});
