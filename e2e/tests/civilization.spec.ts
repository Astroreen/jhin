// A civilization end to end on the fake runtime (docs/plans/agents.md#c3, D1101–D1104):
// a team from a spec, the intent and a mission with slices, the orchestrator
// handing them out, proofs, an ask to the owner and a health warning. Driven
// through commands; it asserts on the records and events the node persists.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { follow, payloadOf, type StreamEvent } from "./support/streams.ts";

const CEREMONY = { ratio: 2, minCeremony: 12 };

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({
    config: {
      "jhin.teams": {
        teams: {
          workshop: {
            title: "Workshop",
            lead: "lead",
            culture: "We ask before we guess.",
            agents: {
              lead: { role: "Talks to the owner and runs missions", runtime: "jhin.agent-fake" },
              builder: { role: "Builds slices and proves them", runtime: "jhin.agent-fake" },
              reviewer: { role: "Reviews what the builder proves", runtime: "jhin.agent-fake" },
            },
          },
        },
      },
      "jhin.health": { ceremony: CEREMONY },
      // The scenario counts every message; refocus would add its own.
      "jhin.orchestrator": { refocusEveryTurns: 0 },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});
/** The streams a test follows, closed after it whether it passed or not. */
const onClose: { close(): void }[] = [];
test.afterEach(() => {
  for (const stream of onClose.splice(0)) stream.close();
});

interface Slice {
  id: string;
  status: string;
  threads?: { threadId: string }[];
  proof?: unknown[];
}

test("D1101–D1104: a team runs a mission: handoffs, proofs, an ask to the owner and a health warning", async ({
  page,
}, info) => {
  const client = node.client();
  const missions = follow(client, "missions");
  onClose.push(missions);
  const workflows = follow(client, "orchestration");
  onClose.push(workflows);
  const inbox = follow(client, "agents/inbox");
  onClose.push(inbox);
  const health = follow(client, "health");
  onClose.push(health);
  const messages = follow(client, "agents/messages");
  onClose.push(messages);

  // 1. The team comes up from its spec.
  const up = await client.call<{ members: { member: string; address: string }[] }>("teams.up", {
    teamId: "workshop",
  });
  const address = Object.fromEntries(up.members.map((item) => [item.member, item.address]));
  expect(Object.keys(address).toSorted()).toEqual(["builder", "lead", "reviewer"]);
  const nodeId = /^jhin:\/\/([^/]+)\//.exec(address.lead!)![1]!;
  const owner = `jhin://${nodeId}/owner`;

  // 2. The intent, a mission and its slices: two in wave 1, one in wave 2.
  const dir = Path.join(node.home, "doghouse");
  Fs.mkdirSync(dir, { recursive: true });
  const project = await client.call<{ id: string }>("projects.create", { path: dir });
  await client.call("missions.intent.set", {
    projectId: project.id,
    intent: "The dog sleeps dry.",
  });
  const mission = await client.call<{ id: string }>("missions.create", {
    projectId: project.id,
    title: "Doghouse",
    outcome: "A doghouse stands, and the dog uses it.",
    status: "active",
  });
  const slice = (fields: Record<string, unknown>) =>
    client.call<Slice>("slices.create", { missionId: mission.id, ...fields });
  const walls = await slice({
    title: "Walls",
    spec: "Four walls stand.",
    assignee: address.builder,
  });
  const review = await slice({
    title: "Review the plan",
    spec: "The plan fits the dog.",
    assignee: address.reviewer,
  });
  const roof = await slice({
    title: "Roof",
    spec: "The roof keeps the rain out.",
    assignee: address.builder,
    dependsOn: [walls.id],
  });

  // 3. The owner talks to the lead; the lead's thread runs the orchestrator.
  // The message starts the lead's first generation and lands in its thread.
  const sent = await client.call<{ delivery?: { threadId: string } }>("agents.send", {
    to: address.lead,
    body: "Run the doghouse mission.",
  });
  const leadThread = sent.delivery!.threadId;
  const sliceIs = (sliceId: string, status: string) =>
    missions
      .until(
        (event) =>
          event.type === "missions.slice.updated" &&
          payloadOf(event).slice.id === sliceId &&
          payloadOf(event).slice.status === status,
      )
      .then((event) => payloadOf(event).slice as Slice);
  const workflowEnds = (workflowId: string) =>
    workflows
      .until(
        (event) =>
          event.type === "orchestration.workflow.updated" &&
          payloadOf(event).workflowId === workflowId &&
          payloadOf(event).status !== "running",
      )
      .then(payloadOf);

  const first = await client.call<{ workflowId: string }>("missions.orchestrate", {
    missionId: mission.id,
    parentThreadId: leadThread,
  });
  // Each slice of wave 1 is handed to its assignee, and their threads are linked.
  const handedWalls = await sliceIs(walls.id, "active");
  const handedReview = await sliceIs(review.id, "active");
  expect(handedWalls.threads).toHaveLength(1);
  expect(handedReview.threads).toHaveLength(1);

  // 4. The reviewer asks the owner; the answer waits in the inbox and goes back.
  const asked = await client.call<{ status: string; message: { messageId: string } }>(
    "agents.ask",
    { to: owner, from: address.reviewer, question: "Is a kennel for one dog enough?" },
  );
  expect(asked.status).toBe("pending");
  await inbox.until(
    (event) =>
      event.type === "agents.inbox.received" &&
      payloadOf(event).message?.messageId === asked.message.messageId,
  );
  const answer = await client.call<{ delivery?: { threadId: string } }>("agents.inbox.answer", {
    messageId: asked.message.messageId,
    answer: "Yes, one dog.",
  });
  // The answer lands in the reviewer's thread, the one its slice links.
  expect(answer.delivery?.threadId).toBe(handedReview.threads![0]!.threadId);
  expect(
    await client.call<{ items: { status: string; answer?: string }[] }>("agents.inbox.list", {
      status: "answered",
    }),
  ).toMatchObject({ items: [{ status: "answered", answer: "Yes, one dog." }] });

  // 5. Proof of wave 1 ends the orchestrator's run with the wave's steps for the lead.
  const prove = (sliceId: string, output: string) =>
    client.call("slices.prove", {
      sliceId,
      items: [{ kind: "command", command: "look at it", output }],
    });
  await prove(walls.id, "four walls stand");
  await prove(review.id, "the plan fits");
  expect(await workflowEnds(first.workflowId)).toMatchObject({
    status: "completed",
    result: { outcome: "wave-done", wave: 1, handed: [walls.id, review.id] },
  });

  // The lead ran the wave's steps and goes on: wave 2.
  const second = await client.call<{ workflowId: string }>("missions.orchestrate", {
    missionId: mission.id,
    parentThreadId: leadThread,
  });
  // The builder's current generation gets it, the thread of its walls.
  expect((await sliceIs(roof.id, "active")).threads?.[0]?.threadId).toBe(
    handedWalls.threads![0]!.threadId,
  );

  // 6. The reviewer keeps asking the builder for more proof of the walls:
  // ceremony, and no progress, until the mission's health warns. Health takes
  // each event as the log appends it, so once the roof's handoff is in the
  // log, `health.status` counts it: the count starts exact.
  await messages.until(
    (event) =>
      event.type === "agents.message.delivered" &&
      payloadOf(event).message.to === address.builder &&
      String(payloadOf(event).message.body).includes("Roof"),
  );
  const missionStatus = async () =>
    (
      await client.call<{
        groups: {
          group: { kind: string; missionId?: string };
          ceremony: number;
          progress: number;
        }[];
      }>("health.status", {})
    ).groups.find((item) => item.group.kind === "mission" && item.group.missionId === mission.id)!;
  const group = await missionStatus();
  const limit = Math.max(CEREMONY.minCeremony, CEREMONY.ratio * Math.max(group.progress, 1));
  expect(group.ceremony).toBeLessThan(limit);
  const missionWarning = (event: StreamEvent) =>
    event.type === "health.warning.raised" &&
    payloadOf(event).warning.detector === "ceremony" &&
    payloadOf(event).warning.group.missionId === mission.id;
  // Each message counts once, as it is sent: the mission reaches its limit
  // with the last one and not before, and a warning needs the limit (D722).
  for (let count = group.ceremony; count < limit; count++) {
    await client.call("agents.send", {
      from: address.reviewer,
      to: address.builder,
      body: "Prove the walls again, please.",
    });
    expect(await missionStatus()).toMatchObject({ ceremony: count + 1, progress: group.progress });
  }
  const raised = payloadOf(await health.until(missionWarning)).warning;
  expect(raised).toMatchObject({
    status: "open",
    measures: { ceremony: limit, progress: group.progress, threshold: limit },
  });
  // The agent with the context is asked why; the fake runtime echoes the question.
  const analysed = payloadOf(
    await health.until(
      (event) =>
        event.type === "health.warning.analysed" && payloadOf(event).warningId === raised.warningId,
    ),
  );
  expect(analysed.analysis.answer).toMatch(/^Echo: /);

  // 7. Wave 2 is proven; the lead closes the mission.
  await prove(roof.id, "the roof keeps the rain out");
  expect(await workflowEnds(second.workflowId)).toMatchObject({
    status: "completed",
    result: { outcome: "slices-done", handed: [roof.id] },
  });
  await client.call("missions.update", { missionId: mission.id, status: "done" });
  const done = await client.call<{ mission: { status: string }; slices: Slice[] }>("missions.get", {
    missionId: mission.id,
  });
  expect(done.mission.status).toBe("done");
  expect(done.slices.map((item) => item.status)).toEqual(["done", "done", "done"]);

  // What the owner sees of it in Civilization mode.
  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  await page
    .getByRole("region", { name: "Missions" })
    .getByRole("button", { name: /^Doghouse/ })
    .click();
  const view = page.locator("[data-mission-view=mission]");
  await expect(view.getByRole("button", { name: "Roof, Done, workshop-builder" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Health" }).getByRole("button", {
      name: /^Mission Doghouse.*Ceremony outgrows progress/,
    }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("civilization.png") });
});
