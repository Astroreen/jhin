// One civilization across the mesh (docs/plans/agents.md, M1: D1527–D1533):
// the client is connected to the laptop only, and reads the agents, the inbox
// and the missions of the server, a member of the laptop's mesh, through it.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

/** Resolves once `node` sees a reachable member named `name`, checked on each event of its mesh stream. */
function untilReachable(node: RunningNode, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = node.client();
    let done = false;
    const check = () =>
      void client
        .call<{ name: string; reachable: boolean }[]>("mesh.nodes")
        .then((nodes) => {
          if (done || !nodes.some((item) => item.name === name && item.reachable)) return;
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

test("D1527–D1532: the agents, inbox and missions of a member, read through the connected node", async ({
  page,
}, info) => {
  const laptop = await startNode({
    config: {
      "jhin.mesh": { name: "Laptop" },
      "jhin.agents": {
        agents: { scout: { title: "Scout", role: "Looks ahead", runtime: "jhin.agent-fake" } },
      },
    },
  });
  running.push(laptop);
  const server = await startNode({
    mode: "serve",
    config: {
      "jhin.mesh": { name: "Server" },
      "jhin.agents": {
        agents: {
          builder: { title: "Builder", role: "Builds slices", runtime: "jhin.agent-fake" },
        },
      },
    },
  });
  running.push(server);
  const invite = await server.client().call<{ url: string; code: string }>("mesh.invite");
  await laptop.client().call("mesh.join", { url: invite.url, code: invite.code });
  await untilReachable(laptop, "Server");

  // On the server: a mission with a slice for its builder, and the builder writing to its owner.
  const client = server.client();
  const { nodeId } = await client.call<{ nodeId: string }>("host.identity");
  const path = Path.join(server.home, "harbor");
  Fs.mkdirSync(path, { recursive: true });
  const project = await client.call<{ id: string }>("projects.create", { path });
  const mission = await client.call<{ id: string }>("missions.create", {
    projectId: project.id,
    title: "Lighthouse",
    outcome: "Ships find the harbor at night.",
    status: "active",
  });
  await client.call("slices.create", {
    missionId: mission.id,
    title: "Lamp",
    spec: "The lamp turns every 10 seconds.",
    assignee: `jhin://${nodeId}/agents/builder`,
  });
  // The builder's first generation exists: the owner's answer is delivered to it at once.
  await client.call("agents.rotate", { agentId: "builder", reason: "the lamp" });
  const written = await client.call<{ message: { messageId: string } }>("agents.send", {
    to: `jhin://${nodeId}/owner`,
    from: `jhin://${nodeId}/agents/builder`,
    body: "The lamp is ready for a review.",
  });
  // The owner's answer, once it is delivered to the builder on the server.
  const answered = new Promise<void>((resolve) => {
    const subscription = client.subscribe("agents/messages", {}, (event) => {
      const message = (event.payload as { message?: { inReplyTo?: string } } | null)?.message;
      if (message?.inReplyTo !== written.message.messageId) return;
      subscription.dispose();
      resolve();
    });
  });

  // The connection shows by its address, the member by its mesh name.
  const here = new URL(laptop.ui).host;
  await page.goto(`${laptop.ui}#token=${laptop.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: /^Civilization/ })
    .click();

  // The roster: each node's agents under its label, the server's through the laptop (D1528).
  const roster = page.getByRole("region", { name: "Agents" });
  await expect(roster.getByText(here, { exact: true })).toBeVisible();
  await expect(roster.getByText("Server", { exact: true })).toBeVisible();
  await expect(roster.getByRole("button", { name: /^Scout,/ })).toBeVisible();
  await expect(roster.getByRole("button", { name: /^Builder,/ })).toBeVisible();

  // The server's inbox item, with its answer box (D1530).
  const inbox = page.getByRole("region", { name: "Inbox" });
  await expect(inbox.getByText("The lamp is ready for a review.")).toBeVisible();

  // The server's missions under its label (D1529).
  const missions = page.getByRole("region", { name: "Missions" });
  const serverMissions = missions.getByRole("navigation", { name: "Missions list, Server" });
  await expect(serverMissions.getByRole("button", { name: "Lighthouse, Active" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mesh-sidebar.png") });

  // The builder's page, on the server (D1528).
  await roster.getByRole("button", { name: /^Builder,/ }).click();
  await expect(page).toHaveURL(/[#&]r=/);
  const agentPage = page.locator("[data-agent-page=builder]");
  await expect(agentPage.getByRole("heading", { name: "Builder" })).toBeVisible();
  await expect(
    agentPage.getByText(`jhin://${nodeId}/agents/builder`, { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("mesh-agent-page.png") });

  // The inbox item opens on the server and is answered there.
  await inbox.getByText("The lamp is ready for a review.").click();
  const question = page.getByRole("region", { name: "Message" });
  await question.getByRole("textbox", { name: "Your answer" }).fill("Go ahead.");
  await page.screenshot({ path: info.outputPath("mesh-inbox-item.png") });
  await question.getByRole("button", { name: "Send answer" }).click();
  // The answer goes to the server through the laptop and is delivered to the builder there.
  await answered;
  await expect(inbox.getByText("Nothing waits for you.")).toBeVisible();

  // The mission, its slice by its agent's title, and every node's agents to assign (D1532).
  await serverMissions.getByRole("button", { name: "Lighthouse, Active" }).click();
  const missionView = page.locator("[data-mission-view=mission]");
  const lamp = missionView.getByRole("button", { name: "Lamp, Planned, Builder" });
  await expect(lamp).toBeVisible();
  await page.screenshot({ path: info.outputPath("mesh-mission.png") });
  await lamp.click();
  const sliceView = page.locator("[data-mission-view=slice]");
  await sliceView.getByRole("button", { name: "Edit slice" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit slice" });
  await dialog.getByRole("combobox", { name: "Assignee" }).click();
  await expect(page.getByRole("option", { name: "Builder", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: `Scout (${here})` })).toBeVisible();
  await expect(page.getByRole("option", { name: `Owner (${here})` })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mesh-assignees.png") });
});
