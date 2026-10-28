import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

async function startThread(page: Page, text: string): Promise<string> {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
  const threadId = /[#&]t=([^&]+)/.exec(page.url())?.[1];
  if (threadId === undefined) throw new Error(`no thread in ${page.url()}`);
  return decodeURIComponent(threadId);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

const PAGE = `<!doctype html><style>
  .bars{display:flex;gap:8px;align-items:end;height:160px}
  .bar{flex:1;background:var(--chart-1);border-radius:var(--radius) var(--radius) 0 0}
  h3{margin:0 0 12px}
</style>
<h3>Weekly sales</h3>
<div class="bars">
  <div class="bar" style="height:40%"></div><div class="bar" style="height:70%"></div>
  <div class="bar" style="height:55%"></div><div class="bar" style="height:90%"></div>
</div>`;

test("D405–D407: an agent's rendered page shows in its turn, themed, and opens full screen", async ({
  page,
}, info) => {
  const threadId = await startThread(page, "chart please");
  // The agent checks the page, then renders it into the thread.
  const preview = await node
    .client()
    .call<{ contentHeight: number }>("html.preview", { html: PAGE });
  expect(preview.contentHeight).toBeGreaterThan(160);
  await node.client().call("html.render", {
    threadId,
    title: "Weekly sales",
    height: preview.contentHeight,
    html: PAGE,
  });

  const frame = page.frameLocator('iframe[title="Weekly sales"]');
  await expect(frame.getByRole("heading", { name: "Weekly sales" })).toBeVisible();
  // The page's colours come from the client's theme.
  const background = await frame
    .locator("html")
    .evaluate((root) => getComputedStyle(root).getPropertyValue("--chart-1").trim());
  expect(background).not.toBe("");
  await shot(page, info, "html-render-light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await shot(page, info, "html-render-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await page.locator("[data-html-render]").hover();
  await page.getByRole("button", { name: "Open full screen" }).click();
  const dialog = page.getByRole("dialog", { name: "Expanded Weekly sales preview" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reset zoom" })).toHaveText("100%");
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(dialog.getByRole("button", { name: "Reset zoom" })).toHaveText("125%");
});

test("D1689: a rendered page reaches nothing over plain HTTP from the reader's client", async ({
  page,
}) => {
  // A server on the reader's loopback, as the node or a device of the reader's network.
  const requests: string[] = [];
  const server = Http.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "access-control-allow-origin": "*" });
    response.end("reached");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const threadId = await startThread(page, "probe please");
    await node.client().call("html.render", {
      threadId,
      title: "Probe",
      height: 120,
      html: `<!doctype html><h3>Probe</h3><p id="result">pending</p>
<img alt="" src="${target}/image">
<script>
fetch("${target}/fetch").then(
  () => { document.getElementById("result").textContent = "reached"; },
  () => { document.getElementById("result").textContent = "blocked"; },
);
</script>`,
    });
    const frame = page.frameLocator('iframe[title="Probe"]');
    // Its own inline script runs; the request never leaves.
    await expect(frame.locator("#result")).toHaveText("blocked");
    expect(requests).toEqual([]);
    // The policy after the doctype keeps the page in standards mode.
    expect(await frame.locator("html").evaluate(() => document.compatMode)).toBe("CSS1Compat");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
