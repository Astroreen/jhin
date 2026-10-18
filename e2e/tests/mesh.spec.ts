import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

interface MeshNode {
  readonly name: string;
  readonly reachable: boolean;
  readonly route?: readonly string[];
}

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

async function start(options: Parameters<typeof startNode>[0]): Promise<RunningNode> {
  const node = await startNode(options);
  running.push(node);
  return node;
}

/** Resolves once `node` sees `name` reachable, re-checking on its mesh stream: no polling. */
function untilReachable(node: RunningNode, name: string): Promise<MeshNode> {
  return new Promise((resolve) => {
    let done = false;
    const check = () =>
      void node
        .client()
        .call<MeshNode[]>("mesh.nodes")
        .then((nodes) => {
          const found = nodes.find((candidate) => candidate.name === name && candidate.reachable);
          if (done || found === undefined) return;
          done = true;
          subscription.dispose();
          resolve(found);
        })
        .catch(() => undefined);
    const subscription = node.client().subscribe("mesh", {}, check);
    check();
  });
}

test("D47: a client connected to a creates a thread on c, two hops away, and gets the reply", async ({
  page,
}, info) => {
  // a and c have no address: everything between them goes through b.
  const a = await start({ mode: "ui", config: { "jhin.mesh": { name: "a", advertise: [] } } });
  const b = await start({ mode: "serve", config: { "jhin.mesh": { name: "b" } } });
  const c = await start({ mode: "serve", config: { "jhin.mesh": { name: "c", advertise: [] } } });
  for (const joiner of [a, c]) {
    const invite = await b.client().call<{ url: string; code: string }>("mesh.invite");
    await joiner.client().call("mesh.join", { url: invite.url, code: invite.code });
  }
  const seen = await untilReachable(a, "c");
  expect(seen.route).toHaveLength(3);

  await page.goto(`${a.ui}#token=${a.token}`);
  const nodeC = page.getByRole("region", { name: "Node c" });
  await nodeC.getByRole("button", { name: "New thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("across the mesh");
  await message.press("Enter");

  const agent = page.getByRole("log", { name: "Messages" }).getByRole("article", { name: "Agent" });
  await expect(agent).toHaveText("Echo: across the mesh");
  await expect(agent).toHaveAttribute("aria-busy", "false");
  // The thread lives on c: it is listed under c, and c's own node has it.
  await expect(
    nodeC.getByRole("button", { name: "New thread", exact: true }).first(),
  ).toBeVisible();
  await expect(nodeC.locator("[aria-current=page]")).toHaveText("New thread");
  const onC = await c.client().call<{ title: string }[]>("threads.list");
  expect(onC.map((thread) => thread.title)).toEqual(["New thread"]);

  const shot = info.outputPath("mesh-chat.png");
  await page.screenshot({ path: shot });
  await info.attach("mesh-chat", { path: shot, contentType: "image/png" });
});

test("D47: one client shows two independent nodes at once", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  const y = await start({ mode: "serve" });

  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(page.getByLabel("Connection open")).toHaveCount(1);
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Node URL" }).fill(y.rpc);
  await page.getByRole("textbox", { name: "Token" }).fill(y.token);
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByLabel("Connection open")).toHaveCount(2);
  const nodeY = page.getByRole("region", { name: `Node ${new URL(y.rpc).host}` });
  await nodeY.getByRole("button", { name: "New thread" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("hello y");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: hello y");
  expect((await y.client().call<{ title: string }[]>("threads.list")).length).toBe(1);
  expect((await x.client().call<{ title: string }[]>("threads.list")).length).toBe(0);

  const shot = info.outputPath("two-nodes.png");
  await page.screenshot({ path: shot });
  await info.attach("two-nodes", { path: shot, contentType: "image/png" });
});
