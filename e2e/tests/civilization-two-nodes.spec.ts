// A civilization across two real nodes (docs/plans/agents.md, M3: D1563): C3's
// scenario (D1101) with its team split over a laptop and a server. The owner
// works from a client of the laptop; the server goes away mid-mission and
// comes back on its home (D1547–D1549). The agents' own acts are commands sent
// for them (D1102), on the node they live on.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { follow, payloadOf } from "./support/streams.ts";

const running: RunningNode[] = [];
const onClose: { close(): void }[] = [];
test.afterEach(async () => {
  for (const stream of onClose.splice(0)) stream.close();
  for (const node of running.splice(0)) await node.stop();
});

interface Slice {
  id: string;
  status: string;
  threads: { threadId: string; nodeId?: string }[];
}

/** Resolves once `node` sees the member `name` as `reachable`, checked on each event of its mesh stream. */
function untilMember(node: RunningNode, name: string, reachable: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = node.client();
    let done = false;
    const check = () =>
      void client
        .call<{ name: string; reachable: boolean }[]>("mesh.nodes")
        .then((nodes) => {
          if (done || !nodes.some((item) => item.name === name && item.reachable === reachable))
            return;
          done = true;
          subscription.dispose();
          resolve();
        })
        .catch(() => undefined);
    const subscription = client.subscribe(
      "mesh",
      { onError: (error) => reject(new Error(`mesh stream refused: ${error.message}`)) },
      check,
    );
    check();
  });
}

const SERVER = { "jhin.mesh": { name: "Server" }, "jhin.orchestrator": { refocusEveryTurns: 0 } };

test("D1563: a team split over two nodes runs a mission, and goes on once the server away is back", async ({
  page,
}, info) => {
  let server = await startNode({ mode: "serve", config: SERVER });
  running.push(server);
  const serverId = (await server.client().call<{ nodeId: string }>("host.identity")).nodeId;
  const fake = "jhin.agent-fake";
  const laptop = await startNode({
    config: {
      "jhin.mesh": { name: "Laptop" },
      "jhin.orchestrator": { refocusEveryTurns: 0 },
      "jhin.teams": {
        teams: {
          crew: {
            title: "Crew",
            lead: "lead",
            agents: {
              lead: { title: "Lead", role: "Talks to the owner and runs missions", runtime: fake },
              builder: { title: "Builder", role: "Builds slices", runtime: fake },
              builder2: {
                title: "Builder 2",
                role: "Builds slices",
                runtime: fake,
                node: serverId,
              },
            },
          },
        },
      },
    },
  });
  running.push(laptop);
  const invite = await server.client().call<{ url: string; code: string }>("mesh.invite");
  await laptop.client().call("mesh.join", { url: invite.url, code: invite.code });
  await untilMember(laptop, "Server", true);

  const client = laptop.client();
  const { nodeId: laptopId } = await client.call<{ nodeId: string }>("host.identity");
  const missions = follow(client, "missions");
  const workflows = follow(client, "orchestration");
  const inbox = follow(client, "agents/inbox");
  const health = follow(client, "health");
  onClose.push(missions, workflows, inbox, health);

  // 1. The team comes up over both nodes.
  const up = await client.call<{ members: { member: string; address: string }[] }>("teams.up", {
    teamId: "crew",
  });
  const address = Object.fromEntries(up.members.map((item) => [item.member, item.address]));
  expect(address.builder2).toBe(`jhin://${serverId}/agents/crew-builder2`);

  // 2. The lead's plan on the laptop: one slice for each builder, on each node.
  const dir = Path.join(laptop.home, "doghouse");
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
  const roof = await slice({
    title: "Roof",
    spec: "The roof keeps the rain out.",
    assignee: address.builder2,
  });

  // 3. The owner steers from the client: the team's page, then the Lead view (C1, D1062).
  await page.goto(`${laptop.ui}#token=${laptop.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: /^Civilization/ })
    .click();
  await page.getByRole("region", { name: "Teams" }).getByRole("button", { name: /Crew/ }).click();
  const team = page.getByRole("region", { name: "Team Crew" });
  await expect(team.getByRole("list", { name: "Agents" }).getByText("builder2@crew")).toBeVisible();
  await page.screenshot({ path: info.outputPath("two-nodes-team.png") });
  await team.getByRole("button", { name: "Talk to the lead" }).click();
  const leadView = page.getByRole("region", { name: "Lead view" });
  const composer = leadView.getByRole("textbox", { name: "Message to the lead" });
  await composer.fill("Run the doghouse mission over both nodes.");
  await composer.press("Enter");
  const conversation = leadView.getByRole("log", { name: "Conversation with the lead" });
  await expect(conversation.getByRole("article", { name: "Lead" })).toContainText(
    "Run the doghouse mission",
  );
  const lead = await client.call<{ generations: { threadId: string }[] }>("agents.get", {
    agentId: "crew-lead",
  });
  const leadThread = lead.generations[0]!.threadId;
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
  await sliceIs(walls.id, "active");
  const handedRoof = await sliceIs(roof.id, "active");
  // The roof's thread is on the server (D1541).
  expect(handedRoof.threads).toEqual([{ threadId: expect.any(String), nodeId: serverId }]);

  // The mission view shows both slices at work, by their agents' titles (D1532).
  const missionsSection = page.getByRole("region", { name: "Missions" });
  await missionsSection.getByRole("button", { name: "Doghouse, Active" }).click();
  const missionView = page.locator("[data-mission-view=mission]");
  await expect(missionView.getByRole("button", { name: "Walls, Active, Builder" })).toBeVisible();
  await expect(missionView.getByRole("button", { name: "Roof, Active, Builder 2" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("two-nodes-mission.png") });

  // 4. The laptop's builder proves; builder2 on the server writes to the owner.
  await client.call("slices.prove", {
    sliceId: walls.id,
    items: [{ kind: "command", command: "look at it", output: "four walls stand" }],
  });
  const note = await server.client().call<{ message: { messageId: string } }>("agents.send", {
    to: `jhin://${laptopId}/owner`,
    from: address.builder2,
    body: "The roof tiles are wet.",
  });
  await inbox.until(
    (event) =>
      event.type === "agents.inbox.received" &&
      payloadOf(event).message?.messageId === note.message.messageId,
  );

  // 5. The server goes away mid-mission.
  const serverHome = server.home;
  const serverPort = Number(new URL(server.rpc).port);
  await server.stop();
  running.splice(running.indexOf(server), 1);
  await untilMember(laptop, "Server", false);
  // The lead is woken with the decision (D1547) …
  expect(await workflowEnds(first.workflowId)).toMatchObject({
    status: "completed",
    result: { outcome: "decide", decisions: [{ sliceId: roof.id, reason: "away" }] },
  });
  // … the owner is warned (D1548) …
  const raised = await health.until(
    (event) =>
      event.type === "health.warning.raised" && payloadOf(event).warning.detector === "away",
  );
  // Named as the mesh names it (D1564).
  const summary = "1 slice of «Doghouse» waits on node Server, which is away";
  expect(payloadOf(raised).warning.summary).toBe(summary);
  const healthSection = page.getByRole("region", { name: "Health" });
  const awayWarning = healthSection.getByRole("button", {
    name: "Mission Doghouse A node is away",
  });
  await awayWarning.click();
  const warningPage = page.getByRole("region", { name: "Health warning" });
  await expect(warningPage.getByText(summary)).toBeVisible();
  // Nobody is asked to analyse a node away (D1548): the page says so (D1564).
  await expect(warningPage.getByText(/^Nobody is asked/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("two-nodes-away-warning.png") });
  // … and the message's answer waits until its sender is back (D1549). The
  // mark is read when the inbox loads (agents.md#deferred, M2).
  await page.reload();
  const inboxSection = page.getByRole("region", { name: "Inbox" });
  await inboxSection.getByText("The roof tiles are wet.").click();
  const item = page.getByRole("region", { name: "Message" });
  await expect(
    item.getByText("Its sender's node is away: an answer cannot reach it until the node is back."),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("two-nodes-away.png") });

  // 6. The server comes back on its home and port: the warning clears itself.
  server = await startNode({
    mode: "serve",
    home: serverHome,
    config: { ...SERVER, "jhin.http": { port: serverPort } },
  });
  running.push(server);
  await untilMember(laptop, "Server", true);
  const cleared = await health.until(
    (event) =>
      event.type === "health.warning.cleared" &&
      payloadOf(event).warningId === payloadOf(raised).warning.warningId,
  );
  expect(payloadOf(cleared).reason).toBe("node-back");
  await expect(awayWarning).toHaveCount(0);

  // The owner answers from the client; the answer reaches builder2 on the server.
  await page.reload();
  await inboxSection.getByText("The roof tiles are wet.").click();
  await item.getByRole("textbox", { name: "Your answer" }).fill("Dry them first.");
  const serverMessages = follow(server.client(), "agents/messages");
  onClose.push(serverMessages);
  await item.getByRole("button", { name: "Send answer" }).click();
  await expect(inboxSection.getByText("Nothing waits for you.")).toBeVisible();
  // The answer is delivered to builder2 on the server, in reply to its message.
  const reply = await serverMessages.until(
    (event) =>
      event.type === "agents.message.delivered" &&
      payloadOf(event).message.inReplyTo === note.message.messageId,
  );
  expect(payloadOf(reply).message).toMatchObject({ to: address.builder2, body: "Dry them first." });

  // 7. The lead runs it again; builder2 proves on the server, naming the mission's node.
  const second = await client.call<{ workflowId: string }>("missions.orchestrate", {
    missionId: mission.id,
    parentThreadId: leadThread,
  });
  await server.client().call("slices.prove", {
    sliceId: roof.id,
    node: laptopId,
    items: [{ kind: "command", command: "look at it", output: "the roof is dry" }],
  });
  expect(await workflowEnds(second.workflowId)).toMatchObject({
    status: "completed",
    result: { outcome: "slices-done", missionId: mission.id },
  });
  await client.call("missions.close", {
    missionId: mission.id,
    status: "done",
    summary: "Built on both nodes.",
  });
  await missionsSection.getByRole("button", { name: "Doghouse, Done" }).click();
  await expect(missionView.getByRole("button", { name: "Roof, Done, Builder 2" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("two-nodes-done.png") });
});
