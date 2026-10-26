import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

interface Subscribe {
  readonly subscription: string;
  readonly stream: string;
  readonly after: number;
}

/**
 * Records what the page asks of its node's thread streams over the WebSocket:
 * every `rpc.subscribe` to a `thread/<id>` stream and the sequences of the
 * events that come for it. `subscribed(n)` resolves once the n-th exists.
 */
function watchThreadStreams(page: Page) {
  const subscribes: Subscribe[] = [];
  const received = new Map<string, number[]>();
  const waiters: (() => void)[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload) as { method?: string; params?: Partial<Subscribe> };
      const params = message.params;
      if (message.method !== "rpc.subscribe" || !params?.stream?.startsWith("thread/")) return;
      subscribes.push({
        subscription: params.subscription!,
        stream: params.stream,
        after: params.after ?? 0,
      });
      received.set(params.subscription!, []);
      for (const waiter of waiters.splice(0)) waiter();
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload) as {
        method?: string;
        params?: { subscription: string; event: { sequence: number } };
      };
      if (message.method !== "rpc.event" || message.params === undefined) return;
      received.get(message.params.subscription)?.push(message.params.event.sequence);
    });
  });
  return {
    subscribes,
    received,
    subscribed(count: number) {
      return new Promise<Subscribe>((resolve) => {
        const check = () =>
          subscribes.length >= count ? resolve(subscribes[count - 1]!) : waiters.push(check);
        check();
      });
    },
  };
}

test("a reload opens a thread from the history cache and asks only for the new events (loading.md D1589)", async ({
  page,
}, info) => {
  const streams = watchThreadStreams(page);
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  const log = page.getByRole("log", { name: "Messages" });
  for (const [index, text] of ["first question", "second question"].entries()) {
    await message.fill(text);
    await message.press("Enter");
    await expect(log.getByRole("article", { name: "Agent" })).toHaveCount(index + 1);
    await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }
  const first = await streams.subscribed(1);
  expect(first.after).toBe(0);
  const before = streams.subscribes.length;

  await page.reload();
  // The kept turns, before any event of the stream arrives again.
  const again = await streams.subscribed(before + 1);
  expect(again.stream).toBe(first.stream);
  expect(again.after).toBeGreaterThan(0);
  await expect(log.getByRole("article", { name: "You" })).toHaveText([
    "first question",
    "second question",
  ]);
  // A new turn arrives on the subscription, and nothing it already had.
  await message.fill("third question");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveCount(3);
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: third question",
  );
  const sequences = streams.received.get(again.subscription)!;
  expect(sequences.length).toBeGreaterThan(0);
  expect(sequences.every((sequence) => sequence > again.after)).toBe(true);

  const path = info.outputPath("from-cache.png");
  await page.screenshot({ path });
  await info.attach("from-cache", { path, contentType: "image/png" });
});

/** How many thread streams the page's history cache keeps (its IndexedDB `streams` store). */
const keptStreams = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const opening = indexedDB.open("jhin.history-cache");
        opening.addEventListener("error", () => reject(opening.error));
        opening.addEventListener("success", () => {
          const db = opening.result;
          const counting = db.transaction("streams").objectStore("streams").count();
          counting.addEventListener("success", () => {
            db.close();
            resolve(counting.result);
          });
          counting.addEventListener("error", () => reject(counting.error));
        });
      }),
  );

test("turning off “Keep chat history on this device” deletes it, and threads open from 0 (D1592)", async ({
  page,
}, info) => {
  const streams = watchThreadStreams(page);
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  const log = page.getByRole("log", { name: "Messages" });
  await message.fill("remember me");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveAttribute("aria-busy", "false");
  const thread = page.url();

  await page.getByRole("button", { name: "Settings" }).click();
  const setting = page.getByRole("switch", { name: "Keep chat history on this device" });
  await expect(setting).toBeChecked();
  await setting.scrollIntoViewIfNeeded();
  await expect(page.getByText(/Now 1 thread, about \d+ KB\./)).toBeVisible();
  await expect(page.getByText(/stored unencrypted in this browser profile/)).toBeVisible();
  const on = info.outputPath("setting-on.png");
  await page.screenshot({ path: on });
  await info.attach("setting-on", { path: on, contentType: "image/png" });

  await setting.click();
  await expect(setting).not.toBeChecked();
  // Once the clear is done, the row reads what is kept again.
  await expect(page.getByText(/Nothing is kept now\./)).toBeVisible();
  expect(await keptStreams(page)).toBe(0);
  const off = info.outputPath("setting-off.png");
  await page.screenshot({ path: off });
  await info.attach("setting-off", { path: off, contentType: "image/png" });

  // The setting stays off after a reload, and the thread is read from 0 again.
  const before = streams.subscribes.length;
  await page.goto(thread);
  await page.reload();
  const again = await streams.subscribed(before + 1);
  expect(again.after).toBe(0);
  await expect(log.getByRole("article", { name: "You" })).toHaveText(["remember me"]);
  expect(await keptStreams(page)).toBe(0);
});
