import * as Fs from "node:fs";
import * as Path from "node:path";

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

/**
 * Resolves once `node` sees `name` reachable, re-checking on its mesh stream:
 * no polling. Rejects with the last snapshot it saw once it can no longer
 * learn anything: the connection to `node` goes away or the stream is refused.
 * `onSnapshot` sees every answer of `mesh.nodes`.
 */
function untilReachable(
  node: RunningNode,
  name: string,
  onSnapshot?: (nodes: readonly MeshNode[]) => void,
): Promise<MeshNode> {
  return new Promise((resolve, reject) => {
    const client = node.client();
    let done = false;
    let last = "no answer yet";
    let wasOpen = client.state === "open";
    const finish = () => {
      done = true;
      subscription.dispose();
      state.dispose();
    };
    const fail = (why: string) => {
      if (done) return;
      finish();
      reject(new Error(`${name} never became reachable (${why}); last mesh.nodes: ${last}`));
    };
    const check = () =>
      void client
        .call<MeshNode[]>("mesh.nodes")
        .then((nodes) => {
          if (done) return;
          last = JSON.stringify(nodes);
          onSnapshot?.(nodes);
          const found = nodes.find((candidate) => candidate.name === name && candidate.reachable);
          if (found === undefined) return;
          finish();
          resolve(found);
        })
        .catch((error: unknown) => {
          if (!done) last = `failed: ${(error as Error).message}`;
        });
    const subscription = client.subscribe(
      "mesh",
      { onError: (error) => fail(`mesh stream refused: ${error.message}`) },
      check,
    );
    const state = client.onState((next) => {
      if (next === "open") wasOpen = true;
      else if (next === "closed" || wasOpen) fail(`connection ${next}`);
    });
    check();
  });
}

/** A user plugin with the mesh plugin's id: it shadows the shipped one, so the node has no mesh. */
function withoutMesh(home: string): void {
  const root = Path.join(home, "plugins", "no-mesh");
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: "no-mesh",
      type: "module",
      jhin: { id: "jhin.mesh", version: "0.0.0", apiVersion: 1, side: "server", entry: "index.js" },
    }),
  );
  Fs.writeFileSync(Path.join(root, "index.js"), "export default { activate() {} };\n");
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
  // A second, independent connection whose state changes later.
  const other = await start({ mode: "serve" });
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Node URL" }).fill(other.rpc);
  await page.getByRole("textbox", { name: "Token" }).fill(other.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByLabel("Connection open")).toHaveCount(2);
  const nodeC = page.getByRole("region", { name: "Node c" });
  await nodeC.getByRole("button", { name: "New thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("across the mesh");
  await message.press("Enter");

  const agent = page.getByRole("log", { name: "Messages" }).getByRole("article", { name: "Agent" });
  await expect(agent).toHaveText("Echo: across the mesh");
  await expect(agent).toHaveAttribute("aria-busy", "false");
  // The thread lives on c: it is listed (and selected) under c, and c's own node has it.
  await expect(nodeC.locator("[aria-current=page]")).toHaveText("New thread");
  const onC = await c.client().call<{ title: string }[]>("threads.list");
  expect(onC.map((thread) => thread.title)).toEqual(["New thread"]);

  const shot = info.outputPath("mesh-chat.png");
  await page.screenshot({ path: shot });
  await info.attach("mesh-chat", { path: shot, contentType: "image/png" });

  // Another connection changing state leaves the open remote thread alone (no remount).
  const log = page.getByRole("log", { name: "Messages" });
  // A mark on the element itself: a remount would replace it with a fresh one.
  await log.evaluate((element) => element.setAttribute("data-mark", "kept"));
  await other.stop();
  await expect(page.getByLabel("Connection open")).toHaveCount(1);
  await expect(log).toHaveAttribute("data-mark", "kept");
  await expect(agent).toHaveText("Echo: across the mesh");

  // c leaves: its section goes away and the open thread says why.
  await c.stop();
  await expect(nodeC).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Node unreachable");
});

test("D47: a link to a node the mesh does not know says so", async ({ page }) => {
  const a = await start({ mode: "ui", config: { "jhin.mesh": { name: "a" } } });
  await page.goto(`${a.ui}#token=${a.token}`);
  await page
    .getByRole("region", { name: /^Node / })
    .first()
    .getByRole("button", { name: "New thread" })
    .click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  // The same thread id, but behind a remote node nobody has heard of.
  await page.evaluate(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    params.set("r", "nobody");
    location.hash = params.toString();
  });
  await expect(page.getByRole("status")).toContainText("Node unreachable");
});

test("D47: one client shows two independent nodes at once", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  const y = await start({ mode: "serve" });

  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(page.getByLabel("Connection open")).toHaveCount(1);
  // The form can be left without connecting anything.
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("form", { name: "Connect a node" })).toHaveCount(0);
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

test("D47: a thread a reachable remote cannot share says why and leaves the remote listed", async ({
  page,
}) => {
  const a = await start({ mode: "ui", config: { "jhin.mesh": { name: "a" } } });
  const b = await start({ mode: "serve", config: { "jhin.mesh": { name: "b" } } });
  const invite = await b.client().call<{ url: string; code: string }>("mesh.invite");
  await a.client().call("mesh.join", { url: invite.url, code: invite.code });
  await untilReachable(a, "b");

  await page.goto(`${a.ui}#token=${a.token}`);
  const nodeB = page.getByRole("region", { name: "Node b" });
  await nodeB.getByRole("button", { name: "New thread" }).click();
  await expect(nodeB.locator("[aria-current=page]")).toHaveText("New thread");
  // The same reachable remote, but a thread `mesh.open` refuses to copy.
  await page.evaluate(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    params.set("t", "no/such");
    location.hash = params.toString();
  });

  await expect(page.getByRole("alert")).toContainText(
    "Cannot open this thread: Stream thread/no/such cannot be copied across the mesh",
  );
  // b is still reachable: the failure is the thread's, not the node's.
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(nodeB).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("D47: remote routes on a node without the mesh plugin read as unreachable", async ({
  page,
}) => {
  const a = await start({ mode: "ui", setup: withoutMesh });
  await expect(a.client().call("mesh.nodes")).rejects.toThrow();

  await page.goto(`${a.ui}#token=${a.token}`);
  await expect(page.getByLabel("Connection open")).toHaveCount(1);
  // Only the connection itself is listed: no mesh, so no other nodes.
  const nodes = page.getByRole("region", { name: /^Node / });
  await expect(nodes).toHaveCount(1);
  await nodes.getByRole("button", { name: "New thread" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  await page.evaluate(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    params.set("r", "somewhere");
    location.hash = params.toString();
  });
  await expect(page.getByRole("status")).toContainText("Node unreachable");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
});

test("untilReachable fails with the last snapshot when its node goes away", async () => {
  const a = await start({ mode: "serve", config: { "jhin.mesh": { name: "a" } } });
  const answered = Promise.withResolvers<void>();
  const waiting = untilReachable(a, "ghost", () => answered.resolve());
  await answered.promise;
  // Handled before the node stops, so the rejection is never unhandled.
  const failed = expect(waiting).rejects.toThrow(
    /ghost never became reachable \(connection closed\); last mesh\.nodes: \[\{.*"name":"a"/,
  );
  await a.stop();
  await failed;
});
