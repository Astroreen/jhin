import * as Crypto from "node:crypto";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

// security.md D1191–D1196: an MCP client's sign-in, approved in a real browser.

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({ mode: "serve" });
});
test.afterAll(async () => {
  await node.stop();
});

test("the owner approves an MCP client in the browser and the client gets a token", async ({
  page,
}, info) => {
  // The agent's loopback callback, as Claude Code or Codex listen for one.
  const hits: string[] = [];
  const callback = Http.createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("signed in");
  });
  await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
  const redirect = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`;
  const base = node.rpc.replace(/^ws/, "http").replace(/\/rpc$/, "");
  try {
    const registered = (await (
      await fetch(`${base}/oauth/mcp/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirect] }),
      })
    ).json()) as { client_id: string };
    const verifier = Crypto.randomBytes(48).toString("base64url");
    const challenge = Crypto.createHash("sha256").update(verifier).digest("base64url");

    // The browser holds the node's page session (D421).
    await page.request.post(`${base}/auth/session`, { data: { credential: node.token } });
    await page.goto(
      `${base}/oauth/mcp/authorize?${new URLSearchParams({
        client_id: registered.client_id,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "e2e",
        scope: "threads.read",
      })}`,
    );
    await expect(page.getByRole("heading", { name: "Connect Claude Code" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Permissions asked for" })).toContainText(
      "threads.read",
    );
    await page.screenshot({ path: info.outputPath("mcp-oauth-approve.png") });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/\/callback\?code=/);

    const back = new URL(page.url());
    expect(back.searchParams.get("state")).toBe("e2e");
    expect(back.searchParams.get("iss")).toBe(base);
    expect(hits).toHaveLength(1);
    const token = (await (
      await fetch(`${base}/oauth/mcp/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: back.searchParams.get("code")!,
          client_id: registered.client_id,
          redirect_uri: redirect,
          code_verifier: verifier,
        }),
      })
    ).json()) as { access_token: string; scope: string };
    expect(token.scope).toBe("threads.read");
    expect(token.access_token).toMatch(/^jhd1\./);
  } finally {
    callback.close();
  }
});

test("the approval page names the shell access of what a client asks for (security.md D1517)", async ({
  page,
}, info) => {
  const base = node.rpc.replace(/^ws/, "http").replace(/\/rpc$/, "");
  const redirect = "http://127.0.0.1:9/callback";
  const registered = (await (
    await fetch(`${base}/oauth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirect] }),
    })
  ).json()) as { client_id: string };
  await page.request.post(`${base}/auth/session`, { data: { credential: node.token } });
  await page.goto(
    `${base}/oauth/mcp/authorize?${new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: Crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
      state: "e2e",
      scope: "threads.read threads.write git.write terminals.write",
    })}`,
  );
  const asked = page.getByRole("list", { name: "Permissions asked for" });
  await expect(asked.getByRole("listitem")).toHaveText([
    /^View threads/,
    /Shell access: an agent it starts in full access runs commands on this machine as the node's user\./,
    /Shell access: a repository's hooks run on this machine as the node's user\./,
    /Shell access: runs commands on this machine as the node's user\./,
  ]);
  await expect(asked.getByRole("listitem").first()).not.toContainText("Shell access");
  await page.screenshot({ path: info.outputPath("mcp-oauth-shell-access.png"), fullPage: true });
});
