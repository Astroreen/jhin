import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Preview page</title>
    <style>body{margin:0;font:16px sans-serif} input{display:block;box-sizing:border-box;width:100%;height:120px;font-size:32px}</style>
    <input aria-label="Field" id="field" oninput="echo.textContent = 'typed: ' + this.value">
    <p id="echo"></p>
    <button onclick="document.title='Agent clicked'">Agent button</button>
    <a href="/second">Second</a>`,
  "/second": `<!doctype html><title>Second page</title><h1>Second</h1>`,
  "/dialog": `<!doctype html><title>Dialog page</title><style>body{margin:0}</style>
    <button style="width:100%;height:100vh" onclick="document.title = confirm('Leave this page?') ? 'Confirmed' : 'Kept'">Ask</button>`,
};

let node: RunningNode;
let server: Http.Server;
let origin = "";
test.beforeAll(async () => {
  node = await startNode();
  server = Http.createServer((request, response) => {
    const page = PAGES[request.url ?? "/"];
    response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html" });
    response.end(page ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await node.stop();
  await new Promise((resolve) => server.close(resolve));
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

test("D403: the agent's tab shows in the right panel, and the user takes it over", async ({
  page,
}, info) => {
  const threadId = await startThread(page, "preview please");

  // The agent opens a page to show the user: the thread's right panel comes up with it.
  const opened = await node
    .client()
    .call<{ tabId: string }>("preview.open", { threadId, url: `${origin}/` });
  const panel = page.getByRole("complementary", { name: "Right panel" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Preview page" })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText("Agent has control");
  await expect(panel.getByRole("textbox", { name: "Address" })).toHaveValue(`${origin}/`);
  await expect(panel.getByRole("textbox", { name: "Address" })).toBeDisabled();

  // The agent acts; its result reaches the panel.
  await node.client().call("preview.click", {
    threadId,
    locator: "role=button[name='Agent button']",
  });
  await expect(panel.getByRole("tab", { name: "Agent clicked" })).toBeVisible();
  await expect(panel.locator("[data-preview-canvas]")).toBeVisible();
  await shot(page, info, "preview-agent");

  // While another viewer holds the tab, this one only watches.
  await node.client().call("preview.tab.control", {
    threadId,
    tabId: opened.tabId,
    viewer: "another-viewer",
    take: true,
  });
  await expect(panel.getByRole("status")).toHaveText("Another viewer has control");
  await expect(panel.getByRole("button", { name: "Take control" })).toBeDisabled();
  await shot(page, info, "preview-another-viewer");
  await node.client().call("preview.tab.control", {
    threadId,
    tabId: opened.tabId,
    viewer: "another-viewer",
    take: false,
  });
  await expect(panel.getByRole("status")).toHaveText("Agent has control");

  // The user takes control: the agent may no longer act.
  await panel.getByRole("button", { name: "Take control" }).click();
  await expect(panel.getByRole("status")).toHaveText("You have control");
  await expect(node.client().call("preview.press", { threadId, key: "Tab" })).rejects.toMatchObject(
    { code: "PREVIEW_CONTROL" },
  );

  // A click on the page and typing reach it, through the canvas and the hidden input.
  const canvas = panel.locator("[data-preview-canvas]");
  // A click lands once the page is on the canvas.
  await expect(canvas).toHaveAttribute("data-painted", "true");
  const box = (await canvas.boundingBox())!;
  // The canvas's middle is on the page however the frame is letterboxed.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel.getByRole("textbox", { name: "Browser page" })).toBeFocused();
  // Tab reaches the page's first field, then the typing goes into it.
  await page.keyboard.press("Tab");
  await page.keyboard.type("hello");
  // The agent may read a tab the user drives: it waits until the page shows the text.
  await node.client().call("preview.wait.for", {
    threadId,
    tabId: opened.tabId,
    text: "typed: hello",
  });
  await panel.getByRole("button", { name: "Release control" }).click();
  await expect(panel.getByRole("status")).toHaveText("Agent has control");
  await node.client().call("preview.press", { threadId, key: "Tab" });
});

test("D950: a server a terminal started shows under Local servers and opens", async ({
  page,
}, info) => {
  const threadId = await startThread(page, "serve please");
  const terminal = { threadId, terminalId: "dev-server" };
  await node.client().call("terminals.open", { ...terminal, cwd: node.home });
  // The dev server goes with its terminal, also when an assertion fails.
  try {
    // A dev server: an HTML page on a free port of this machine.
    const script =
      "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');" +
      "s.end('<title>Dev server</title><h1>dev</h1>')}).listen(0,'127.0.0.1')";
    await node.client().call("terminals.write", {
      ...terminal,
      data: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}\r`,
    });

    await page.getByRole("button", { name: "Toggle right panel" }).click();
    const panel = page.getByRole("complementary", { name: "Right panel" });
    const servers = panel.getByRole("region", { name: "Local servers" });
    const row = servers.getByRole("button", { name: /^node localhost:\d+$/ });
    await expect(row).toBeVisible();
    await expect(servers).toContainText(
      "Select a live local server to open it in this browser tab.",
    );
    await shot(page, info, "local-servers");

    await row.click();
    await expect(panel.getByRole("tab", { name: "Dev server" })).toBeVisible();
  } finally {
    await node.client().call("terminals.close", terminal);
  }
});

test("D403: the user opens a page from the address bar and sizes it like a device", async ({
  page,
}, info) => {
  await startThread(page, "browse please");
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  const panel = page.getByRole("complementary", { name: "Right panel" });
  await expect(panel.getByText("No preview yet")).toBeVisible();

  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill(`${origin}/second`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  // A tab the user opened is theirs to drive at once.
  await expect(panel.getByRole("status")).toHaveText("You have control");

  await panel.getByRole("button", { name: "Preview menu" }).click();
  await page.getByRole("menuitem", { name: "Show device toolbar" }).click();
  const toolbar = panel.getByRole("toolbar", { name: "Browser device toolbar" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("combobox", { name: "Browser device preset" }).click();
  await page.getByRole("option", { name: /iPhone 12 Pro/ }).click();
  await expect(toolbar.getByRole("textbox", { name: "Viewport width" })).toHaveValue("390");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, info, "preview-device-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await toolbar.getByRole("button", { name: "Close device toolbar" }).click();
  await expect(toolbar).toBeHidden();

  // A page's dialog shows over it; the user answers it.
  await address.fill(`${origin}/dialog`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Dialog page" })).toBeVisible();
  const canvas = panel.locator("[data-preview-canvas]");
  await expect(canvas).toHaveAttribute("data-painted", "true");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const dialog = panel.getByRole("alertdialog");
  await expect(dialog).toContainText("Leave this page?");
  await shot(page, info, "preview-dialog");
  await dialog.getByRole("button", { name: "Accept" }).click();
  await expect(panel.getByRole("tab", { name: "Confirmed" })).toBeVisible();
  await expect(dialog).toBeHidden();

  // The tab closes from its strip; the header toggle hides the panel.
  await panel.getByRole("button", { name: "Close Confirmed" }).click();
  // Back to a new tab, which offers the page just visited.
  await expect(panel.getByRole("region", { name: "Recently used" })).toContainText("Second page");
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expect(panel).toBeHidden();
});
