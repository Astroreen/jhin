// Civilization mode's mission view (docs/plans/agents.md, A3: D653–D656): the
// Missions section, a mission with the project's intent and its waves, a slice
// with its spec and proof, and the thread of the agent working on it, read only.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({
    config: {
      "jhin.agents": {
        agents: {
          builder: {
            title: "Builder",
            role: "Builds slices and proves them",
            runtime: "jhin.agent-fake",
          },
        },
      },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});

test("D653–D656: mission → slice → the agent's thread, read only, kept current", async ({
  page,
}, info) => {
  const client = node.client();
  const path = Path.join(node.home, "harbor");
  Fs.mkdirSync(path, { recursive: true });
  const project = await client.call<{ id: string }>("projects.create", { path });
  await client.call("missions.intent.set", {
    projectId: project.id,
    intent: "A harbor where agents ship work the owner can trust.",
  });
  const mission = await client.call<{ id: string }>("missions.create", {
    projectId: project.id,
    title: "Missions in the client",
    outcome: "The owner reads every mission, slice and proof without asking.",
    status: "active",
  });
  const store = await client.call<{ id: string }>("slices.create", {
    missionId: mission.id,
    title: "Missions store",
    spec: "The client folds the missions stream.",
    assignee: "jhin://local/agents/builder",
  });
  const view = await client.call<{ id: string }>("slices.create", {
    missionId: mission.id,
    title: "Mission view",
    spec: "A mission shows its waves of slices.",
    dependsOn: [store.id],
    assignee: "jhin://local/owner",
    status: "active",
  });
  await client.call("slices.update", { sliceId: view.id, step: "build" });
  const { generation } = await client.call<{ generation: { threadId: string } }>("agents.rotate", {
    agentId: "builder",
    reason: "the store slice",
  });
  await client.call("threads.send", { threadId: generation.threadId, text: "fold the stream" });
  await client.call("slices.link", { sliceId: store.id, threadId: generation.threadId });
  await client.call("slices.prove", {
    sliceId: store.id,
    items: [
      { kind: "command", command: "vp test run test/missions-view.test.ts", output: "7 passed" },
      { kind: "link", url: "https://example.com/pr/1", title: "The pull request" },
    ],
  });

  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByRole("button", { name: "Start a thread" })).toBeVisible();
  // Nothing of it goes into Threads mode (D741).
  await expect(page.getByText("Missions in the client")).toHaveCount(0);

  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const section = page.getByRole("region", { name: "Missions" });
  await section.getByRole("button", { name: "Missions in the client, Active" }).click();
  await expect(page).toHaveURL(/[#&]p=mission/);

  const missionView = page.locator("[data-mission-view=mission]");
  await expect(missionView.getByRole("heading", { name: "Missions in the client" })).toBeVisible();
  await expect(
    missionView
      .getByRole("region", { name: "Project intent" })
      .getByText("A harbor where agents ship work the owner can trust."),
  ).toBeVisible();
  await expect(
    missionView.getByText("The owner reads every mission, slice and proof without asking."),
  ).toBeVisible();
  const wave1 = missionView.getByRole("region", { name: "Wave 1" });
  const wave2 = missionView.getByRole("region", { name: "Wave 2" });
  await expect(wave1.getByRole("button", { name: "Missions store, Done, builder" })).toBeVisible();
  await expect(wave1.getByLabel("Proven")).toBeVisible();
  await expect(wave2.getByRole("button", { name: "Mission view, Active, Owner" })).toBeVisible();
  await expect(wave2.getByText("build", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mission.png") });

  // The view follows the stream: a change made elsewhere shows without a reload.
  await client.call("slices.update", { sliceId: view.id, status: "blocked" });
  await expect(wave2.getByRole("button", { name: "Mission view, Blocked, Owner" })).toBeVisible();

  await wave1.getByRole("button", { name: /^Missions store/ }).click();
  const sliceView = page.locator("[data-mission-view=slice]");
  await expect(sliceView.getByRole("heading", { name: "Missions store" })).toBeVisible();
  await expect(sliceView.getByText("The client folds the missions stream.")).toBeVisible();
  const proof = sliceView.getByRole("region", { name: "Proof" });
  await expect(proof.getByText("$ vp test run test/missions-view.test.ts")).toBeVisible();
  await expect(proof.getByText("7 passed")).toBeVisible();
  await expect(proof.getByRole("link", { name: "The pull request" })).toHaveAttribute(
    "href",
    "https://example.com/pr/1",
  );
  const threads = sliceView.getByRole("region", { name: "Threads" });
  await expect(threads.getByRole("button", { name: /Builder/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("slice.png") });

  await threads.getByRole("button", { name: /Builder/ }).click();
  const threadView = page.locator("[data-mission-view=thread]");
  const transcript = threadView.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("fold the stream", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Echo: fold the stream")).toBeVisible();
  // Observed, not driven (D741): nothing to type into.
  await expect(threadView.getByRole("textbox")).toHaveCount(0);
  const crumbs = threadView.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByText("harbor")).toBeVisible();
  await expect(crumbs.getByText(/^Builder/)).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: info.outputPath("thread.png") });

  // Back up the chain through the breadcrumb.
  await crumbs.getByRole("button", { name: "Missions in the client" }).click();
  await expect(missionView.getByRole("region", { name: "Wave 1" })).toBeVisible();
});

test("D1081–D1085: the owner plans a mission, its intent and slices from the view", async ({
  page,
}, info) => {
  const client = node.client();
  const path = Path.join(node.home, "lighthouse");
  Fs.mkdirSync(path, { recursive: true });
  const project = await client.call<{ id: string }>("projects.create", { path });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const section = page.getByRole("region", { name: "Missions" });
  await section.getByRole("button", { name: "New mission" }).click();

  let dialog = page.getByRole("dialog", { name: "New mission" });
  await dialog.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: "lighthouse" }).click();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Light the coast");
  await dialog.getByRole("textbox", { name: "Outcome" }).fill("Ships find the harbor at night.");
  await dialog.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Active" }).click();
  await dialog.getByRole("button", { name: "Create mission" }).click();
  await expect(dialog).toHaveCount(0);

  // Creating opens the mission; the view shows what the stream says.
  const missionView = page.locator("[data-mission-view=mission]");
  await expect(missionView.getByRole("heading", { name: "Light the coast" })).toBeVisible();
  const intent = missionView.getByRole("region", { name: "Project intent" });
  await intent.getByRole("button", { name: "Edit intent" }).click();
  dialog = page.getByRole("dialog", { name: "Project intent" });
  await dialog.getByRole("textbox", { name: "Intent" }).fill("Every ship comes home.");
  await dialog.getByRole("button", { name: "Save intent" }).click();
  await expect(intent.getByText("Every ship comes home.")).toBeVisible();

  const waves = missionView.getByRole("region", { name: "Waves" });
  await waves.getByRole("button", { name: "Add slice" }).click();
  dialog = page.getByRole("dialog", { name: "New slice" });
  await dialog.getByRole("textbox", { name: "Title" }).fill("Lamp");
  await dialog.getByRole("textbox", { name: "Spec" }).fill("The lamp turns every 10 seconds.");
  await dialog.getByRole("combobox", { name: "Assignee" }).click();
  await page.getByRole("option", { name: "Builder" }).click();
  await dialog.getByRole("button", { name: "Add slice" }).click();
  await expect(dialog).toHaveCount(0);
  const lamp = missionView
    .getByRole("region", { name: "Wave 1" })
    .getByRole("button", { name: "Lamp, Planned, Builder" });
  await expect(lamp).toBeVisible();

  await waves.getByRole("button", { name: "Add slice" }).click();
  dialog = page.getByRole("dialog", { name: "New slice" });
  await dialog.getByRole("textbox", { name: "Title" }).fill("Keeper");
  await dialog.getByRole("textbox", { name: "Spec" }).fill("Someone winds the lamp.");
  await dialog.getByRole("checkbox", { name: "Lamp" }).click();
  await dialog.getByRole("button", { name: "Add slice" }).click();
  await expect(
    missionView
      .getByRole("region", { name: "Wave 2" })
      .getByRole("button", { name: "Keeper, Planned, Unassigned" }),
  ).toBeVisible();

  // A command's refusal stays in the dialog: a dependency must come in an earlier wave (D644).
  await lamp.click();
  const sliceView = page.locator("[data-mission-view=slice]");
  await sliceView.getByRole("button", { name: "Edit slice" }).click();
  dialog = page.getByRole("dialog", { name: "Edit slice" });
  await dialog.getByRole("checkbox", { name: "Keeper" }).click();
  await dialog.getByRole("button", { name: "Save slice" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Keeper" }).click();
  await dialog.getByRole("textbox", { name: "Spec" }).fill("The lamp turns every 5 seconds.");
  await dialog.getByRole("combobox", { name: "Step" }).click();
  await page.getByRole("option", { name: "build" }).click();
  await dialog.getByRole("button", { name: "Save slice" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sliceView.getByText("The lamp turns every 5 seconds.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("slice-edited.png") });

  // Every edit went through the commands into the stream.
  const missions = await client.call<{ id: string; title: string }[]>("missions.list", {
    projectId: project.id,
  });
  expect(missions.map((mission) => mission.title)).toEqual(["Light the coast"]);
  const slices = await client.call<
    { title: string; spec: string; step?: string; assignee?: string }[]
  >("slices.list", { missionId: missions[0]?.id });
  expect(slices.find((slice) => slice.title === "Lamp")).toMatchObject({
    spec: "The lamp turns every 5 seconds.",
    step: "build",
    assignee: expect.stringMatching(/\/agents\/builder$/),
  });
  await expect(
    client.call<{ intent: string }>("missions.intent.get", { projectId: project.id }),
  ).resolves.toMatchObject({ intent: "Every ship comes home." });
});
