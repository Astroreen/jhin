import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

// security.md D419–D424: pairing a second browser by its pairing link, the
// page's own session in an httpOnly cookie, revoking a paired client.

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

async function openAuthorizedClients(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Authorized clients", exact: true })
    .click();
}

/** Everything a script on the page can read of its storage: localStorage, IndexedDB, cookies. */
const readableStorage = (page: Page) =>
  page.evaluate(async () => {
    const indexed = await new Promise<unknown>((resolve) => {
      const opening = indexedDB.open("jhin.connections", 1);
      opening.addEventListener("success", () => {
        const read = opening.result
          .transaction("nodes", "readonly")
          .objectStore("nodes")
          .get("list");
        read.addEventListener("success", () => resolve(read.result));
      });
    });
    return JSON.stringify({ local: { ...localStorage }, indexed, cookie: document.cookie });
  });

test("pairs a second browser by its pairing link, keeps tokens away from scripts, and revokes it", async ({
  page,
  browser,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page).not.toHaveURL(/token=/);
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  // The page's node is reached through its session cookie: no script can read a token.
  expect(await readableStorage(page)).not.toContain(node.token);
  expect(await readableStorage(page)).not.toMatch(/jhd1\.|jhin_session_/);

  await openAuthorizedClients(page);
  await page.getByRole("button", { name: "Create link" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Client label (optional)" }).fill("Second browser");
  // Permissions carry their plugin's title (security.md D961).
  const terminals = dialog.getByRole("checkbox", { name: /^View terminals/ });
  await expect(terminals).toBeChecked();
  await expect(terminals).toHaveAccessibleName(
    "View terminals Read existing terminal output and status. terminals.read",
  );
  await page.screenshot({ path: info.outputPath("pairing-permissions.png") });
  // A permission with shell access says so where it is granted (security.md D1364).
  const shell = dialog.getByRole("checkbox", { name: /^Use terminals/ });
  await expect(shell).toHaveAccessibleName(
    "Use terminals Create terminals and send input to running shells. Shell access: runs commands on this machine as the node's user. terminals.write",
  );
  await shell.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("pairing-shell-access.png") });
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Pairing link — scan to open on another device" }),
  ).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Pairing link QR code" })).toBeVisible();
  const link = await dialog.getByRole("textbox", { name: "Pairing link" }).inputValue();
  expect(link).toMatch(/\/pair#token=[23456789A-HJ-NP-Z]{12}$/);
  await page.screenshot({ path: info.outputPath("pairing-link.png") });
  await dialog.getByRole("button", { name: "Done" }).click();

  // A second browser opens the link and is connected, with no token it can read.
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto(link);
  await expect(other).not.toHaveURL(/token=/);
  await expect(other.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  expect(await readableStorage(other)).not.toMatch(/jhd1\.|jhin_session_/);
  // The code was used up.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await expect(again.getByRole("alert")).toContainText("Request a new pairing link");

  // The first browser lists it and revokes it; the second one is dropped at once.
  const list = page.getByRole("list", { name: /^Authorized clients of / });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await openAuthorizedClients(page);
  await expect(list.getByText("Second browser")).toBeVisible();
  await page.screenshot({ path: info.outputPath("authorized-clients.png") });
  await list.getByRole("button", { name: "Revoke Second browser" }).click();
  await expect(list.getByText("Second browser")).toHaveCount(0);

  await other.getByRole("button", { name: "Settings", exact: true }).click();
  await other
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  await expect(other.getByLabel("Connection closed")).toHaveCount(1);
  await second.close();
});

test("keeps the page's session when it is opened again with the same token", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessions = async () =>
    (
      await node
        .client()
        .call<{ clients: { method: string; label: string }[] }>("auth.clients.list")
    ).clients.filter((client) => client.method === "issued" && client.label === "Browser").length;
  const before = await sessions();
  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  expect(await sessions()).toBe(before + 1);

  await page.goto(`${node.ui}#token=${node.token}`);
  await page.reload();
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  expect(await sessions()).toBe(before + 1);
  await context.close();
});

test("pairs from the connect form with a pairing code", async ({ browser }) => {
  const { code } = await node
    .client()
    .call<{ code: string }>("auth.pairing.create", { label: "Typed code" });
  const context = await browser.newContext();
  const page = await context.newPage();
  // A page of the node without a session shows the connect form.
  await page.goto(node.ui);
  await page.getByRole("textbox", { name: "Node URL" }).fill(node.rpc);
  await page
    .getByRole("textbox", { name: "Pairing code or token" })
    .fill(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  const { clients } = await node
    .client()
    .call<{ clients: { label: string; method: string }[] }>("auth.clients.list");
  // The browser bound the token to a key it cannot read out (security.md D1366, D1368).
  expect(clients).toContainEqual(
    expect.objectContaining({ label: "Typed code", method: "pairing", bound: true }),
  );
  const saved = await page.evaluate(
    () =>
      new Promise<{ token: string; extractable: boolean }>((resolve) => {
        const opening = indexedDB.open("jhin.connections", 1);
        opening.addEventListener("success", () => {
          const read = opening.result
            .transaction("nodes", "readonly")
            .objectStore("nodes")
            .get("list");
          read.addEventListener("success", () => {
            const [saved] = read.result as { token: string; key: { privateKey: CryptoKey } }[];
            resolve({ token: saved!.token, extractable: saved!.key.privateKey.extractable });
          });
        });
      }),
  );
  expect(saved.extractable).toBe(false);
  // A copy of the token alone opens nothing.
  const alone = await page.evaluate(
    ([url, token]) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(url, ["jhin.v1", `jhin.token.${token}`]);
        socket.addEventListener("close", (event) => resolve(event.code));
      }),
    [node.rpc, saved.token] as const,
  );
  expect(alone).toBe(4401);
  // The page itself reconnects through a fresh ticket after a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  await context.close();
});

test("trades the token an older client saved for its own node for a session", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(
    ([rpc, token]) =>
      localStorage.setItem("jhin.nodes", JSON.stringify([{ url: rpc, token, label: "mine" }])),
    [node.rpc, node.token],
  );
  // A second page of the origin hears the saves: the migration, then the
  // session entry that replaces the token.
  const listener = await context.newPage();
  await listener.goto(`${node.ui}client/plugins`);
  const twoSaves = listener.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let heard = 0;
        new BroadcastChannel("jhin.connections").addEventListener("message", () => {
          if (++heard === 2) resolve();
        });
      }),
  );
  const page = await context.newPage();
  await page.goto(node.ui);
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  await twoSaves;
  // The upgraded page reaches its node by the session cookie; the token is gone.
  expect(await readableStorage(page)).not.toContain(node.token);
  await context.close();
});

test("revokes the other clients after asking", async ({ page }) => {
  for (const label of ["Spare one", "Spare two"]) {
    await node.client().call("auth.tokens.issue", { label, permissions: ["threads.read"] });
  }
  await page.goto(`${node.ui}#token=${node.token}`);
  await openAuthorizedClients(page);
  const list = page.getByRole("list", { name: /^Authorized clients of / });
  await expect(list.getByText("Spare one")).toBeVisible();

  await page.getByRole("button", { name: "Revoke others" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Revoke other clients?" });
  await expect(confirm).toContainText("Other paired clients will need a new pairing link");
  await confirm.getByRole("button", { name: "Revoke others" }).click();
  await expect(list.getByText("Spare one")).toHaveCount(0);
  await expect(list.getByText("Spare two")).toHaveCount(0);
  await expect(list.getByText("This device")).toBeVisible();
});

test("follows the node's clients live and shows what each device is (D1187, D1188)", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await openAuthorizedClients(page);
  const list = page.getByRole("list", { name: /^Authorized clients of / });
  await expect(list).toBeVisible();

  // Changes made elsewhere (the CLI, another device) reach the open page.
  const { code } = await node
    .client()
    .call<{ code: string }>("auth.pairing.create", { label: "Kitchen iPad" });
  await expect(list.getByRole("listitem").filter({ hasText: "Kitchen iPad" })).toContainText(
    "Not connected yet.",
  );
  const paired = await fetch(`${node.ui}auth/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
    body: JSON.stringify({ code }),
  });
  const { id } = (await paired.json()) as { id: string };
  const row = list.getByRole("listitem").filter({ hasText: "Kitchen iPad" });
  await expect(row).toContainText("Tablet · iOS · Safari · 127.0.0.1");
  await page.screenshot({ path: info.outputPath("authorized-clients-device.png") });

  await node.client().call("auth.clients.revoke", { id });
  await expect(list.getByText("Kitchen iPad")).toHaveCount(0);
});

test("pairs a jhin client page by the link the node gives for it (D1190)", async ({
  page,
  browser,
}, info) => {
  const clientPage = await startNode({ mode: "client" });
  const linked = await startNode({ config: { "jhin.auth-token": { clientUrl: clientPage.ui } } });
  try {
    await page.goto(`${linked.ui}#token=${linked.token}`);
    await openAuthorizedClients(page);
    await page.getByRole("button", { name: "Create link" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Client label (optional)" }).fill("Travel laptop");
    await dialog.getByRole("button", { name: "Create link" }).click();
    const link = await dialog.getByRole("textbox", { name: "Client page link" }).inputValue();
    expect(link.startsWith(`${clientPage.ui}pair?host=`)).toBe(true);
    expect(link).toMatch(/#token=[23456789A-HJ-NP-Z]{12}$/);
    await page.screenshot({ path: info.outputPath("pairing-client-link.png") });
    await dialog.getByRole("button", { name: "Done" }).click();

    // The client page, served by no node, pairs with the node the link names.
    const context = await browser.newContext();
    const other = await context.newPage();
    await other.goto(link);
    await expect(other).not.toHaveURL(/token=|host=/);
    await expect(other.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
    const { clients } = await linked
      .client()
      .call<{ clients: { label: string; method: string }[] }>("auth.clients.list");
    expect(clients).toContainEqual(
      expect.objectContaining({ label: "Travel laptop", method: "pairing" }),
    );
    // A link naming no node address is refused on the page, not followed.
    const hostile = await (await browser.newContext()).newPage();
    await hostile.goto(
      `${clientPage.ui}pair?host=${encodeURIComponent("javascript:alert(1)")}#token=ABCDEFGHJKMN`,
    );
    await expect(hostile.getByRole("alert")).toContainText("does not name a node address");
    await context.close();
  } finally {
    await linked.stop();
    await clientPage.stop();
  }
});
