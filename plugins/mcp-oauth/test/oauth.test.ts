import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { AGENT_PERMISSIONS } from "@jhin/mcp-api";
import { definePlugin, describePermissions, z } from "@jhin/sdk";
import { createTestKernel, mockCapability, testManifest, type TestKernel } from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import auth from "../../auth-token/src/index.ts";
import http from "../../http/src/index.ts";
import mcpServer from "../../mcp-server/src/index.ts";
import oauth from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

/** A secret store with just what OAuth needs: one random key, kept. */
function memorySecrets() {
  const named = new Map<string, string>();
  return mockCapability(
    "secrets.store",
    {
      readable: true,
      getOrCreateRandom(name: string, bytes: number) {
        if (!named.has(name)) named.set(name, Crypto.randomBytes(bytes).toString("base64url"));
        return named.get(name)!;
      },
    },
    "1.1.0",
  );
}

/** Commands an agent may call, so the default scopes are described. */
const threads = {
  manifest: testManifest("app.threads"),
  definition: definePlugin({
    activate(context) {
      context.commands.register({
        name: "app.threads.read",
        description: "Reads threads",
        input: z.object({}),
        output: z.object({}),
        permissions: ["threads.read"],
        handler: () => ({}),
      });
      // A permission with shell access (security.md D1364).
      context.commands.register({
        name: "app.shell.run",
        description: "Runs a command",
        input: z.object({}),
        output: z.object({}),
        permissions: ["app.shell.run"],
        handler: () => ({}),
      });
      describePermissions(context, {
        "app.shell.run": { title: "Run commands", shellAccess: true },
      });
    },
  }),
};

const kernels: TestKernel[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

async function startNode(): Promise<{
  kernel: TestKernel;
  base: string;
  token: string;
  data: string;
}> {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-mcp-oauth-"));
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      memorySecrets(),
      { manifest: manifest("http"), definition: http },
      { manifest: manifest("auth-token"), definition: auth },
      { manifest: manifest("mcp-server"), definition: mcpServer },
      { manifest: manifest("mcp-oauth"), definition: oauth },
      threads,
    ],
    config: { node: { "jhin.http": { port: 0 } } },
  });
  kernels.push(kernel);
  expect(kernel.inspect().plugins.filter((plugin) => plugin.status !== "active")).toEqual([]);
  const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
  const { token } = (await kernel.commands.execute("auth.token.show", {})) as { token: string };
  return { kernel, base: url, token, data };
}

const REDIRECT = "http://127.0.0.1:33418/callback";
const verifier = Crypto.randomBytes(48).toString("base64url");
const challenge = Crypto.createHash("sha256").update(verifier).digest("base64url");

async function register(base: string, body: unknown = {}) {
  return fetch(`${base}/oauth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code",
      redirect_uris: [REDIRECT],
      ...(body as object),
    }),
  });
}

const authorizeUrl = (base: string, clientId: string, extra: Record<string, string> = {}) =>
  `${base}/oauth/mcp/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT.replace("33418", "40000"),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: `${base}/mcp`,
    ...extra,
  })}`;

/** A page session cookie for `credential` (security.md D421). */
async function sessionCookie(base: string, credential: string): Promise<string> {
  const opened = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  expect(opened.status).toBe(200);
  return opened.headers.get("set-cookie")!.split(";")[0]!;
}

/** The fields of the page's approval form, as a browser posts it unchanged. */
function formOf(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)) {
    fields[match[1]!] = match[2]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  }
  // The access level the page has chosen (security.md D1369).
  const checked = /<input type="radio" name="access" value="([^"]+)" checked \/>/.exec(html);
  if (checked !== null) fields["access"] = checked[1]!;
  return fields;
}

describe("MCP OAuth (security.md D1191–D1196)", () => {
  it("advertises itself on /mcp's 401 and in both metadata documents", async () => {
    const { base } = await startNode();
    const refused = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: AGENT_PERMISSIONS,
    });
    // A browser-based client preflights the metadata too.
    const preflight = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
    const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/mcp/authorize`,
      token_endpoint: `${base}/oauth/mcp/token`,
      registration_endpoint: `${base}/oauth/mcp/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  it("signs a client in: register, approve in the browser, exchange the code, call /mcp, revoke", async () => {
    const { kernel, base, token } = await startNode();
    const registered = await register(base);
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    // Without a session, the page asks for a pairing code and offers no Approve.
    const anonymous = await (await fetch(authorizeUrl(base, clientId))).text();
    expect(anonymous).toContain("Connect Claude Code");
    expect(anonymous).toContain("Paste a one-time pairing code");
    expect(anonymous).not.toContain('value="approve"');

    // A pairing code opens the page's session, which approves.
    const { code: pairingCode } = (await kernel.commands.execute("auth.pairing.create", {})) as {
      code: string;
    };
    const cookie = await sessionCookie(base, pairingCode);
    const page = await fetch(authorizeUrl(base, clientId, { scope: "threads.read" }), {
      headers: { cookie },
    });
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain('value="approve"');
    expect(html).toContain("threads.read");
    expect(html).toContain(
      "Approval returns to 127.0.0.1:40000 on the computer that opened this page.",
    );

    const form = formOf(html);
    const forged = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
      body: new URLSearchParams({ ...form, csrf: "forged", decision: "approve" }),
    });
    expect(forged.status).toBe(403);
    const foreign = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin: "https://evil.example",
      },
      body: new URLSearchParams({ ...form, decision: "approve" }),
    });
    expect(foreign.status).toBe(403);

    const noOrigin = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...form, decision: "approve" }),
    });
    expect(noOrigin.status).toBe(403);
    const opaque = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: "null" },
      body: new URLSearchParams({ ...form, decision: "approve" }),
    });
    expect(opaque.status).toBe(403);
    for (const decision of [undefined, "", "approved"]) {
      const undecided = await fetch(`${base}/oauth/mcp/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
        body: new URLSearchParams({ ...form, ...(decision === undefined ? {} : { decision }) }),
      });
      expect(undecided.status).toBe(400);
    }
    // Another browser session of the same owner cannot reuse this page's value.
    const otherSession = await sessionCookie(base, token);
    const replayed = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: otherSession,
        origin: base,
      },
      body: new URLSearchParams({ ...form, decision: "approve" }),
    });
    expect(replayed.status).toBe(403);

    const approved = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
      body: new URLSearchParams({ ...form, decision: "approve" }),
    });
    expect(approved.status).toBe(303);
    const back = new URL(approved.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe("http://127.0.0.1:40000/callback");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe(base);
    const code = back.searchParams.get("code")!;

    const exchange = (body: Record<string, string>) =>
      fetch(`${base}/oauth/mcp/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "claude-code/2.0",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT.replace("33418", "40000"),
          code_verifier: verifier,
          resource: `${base}/mcp`,
          ...body,
        }),
      });
    const granted = await exchange({});
    expect(granted.status).toBe(200);
    expect(granted.headers.get("cache-control")).toBe("no-store");
    const issued = (await granted.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(issued).toMatchObject({ token_type: "Bearer", scope: "threads.read" });
    expect(issued.access_token).toMatch(/^jhd1\./);
    expect(issued.expires_in).toBeGreaterThan(29 * 86_400);
    // One use.
    expect((await exchange({})).status).toBe(400);

    const listed = (await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }).then((response) => response.json())) as { result: { tools: { name: string }[] } };
    const tools = listed.result.tools.map((tool) => tool.name);
    // MCP tool names are command names with `_` for `.` (`@jhin/mcp-bridge`'s toolName).
    expect(tools).toContain("app_threads_read");
    for (const denied of ["auth_tokens_issue", "auth_clients_list", "auth_pairing_create"]) {
      expect(tools).not.toContain(denied);
    }

    const { clients } = (await kernel.commands.execute("auth.clients.list", {})) as {
      clients: {
        id: string;
        label: string;
        method: string;
        permissions: string[];
        metadata?: object;
      }[];
    };
    const client = clients.find((entry) => entry.method === "oauth")!;
    expect(client).toMatchObject({
      label: "Claude Code",
      permissions: ["threads.read"],
      metadata: { deviceType: "desktop", userAgent: "claude-code/2.0" },
    });
    await kernel.commands.execute("auth.clients.revoke", { id: client.id });
    const after = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(after.status).toBe(401);
    expect(token).not.toBe(issued.access_token);
  });

  it("says a pattern that covers shell access grants it (security.md D1364)", async () => {
    const { base } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as {
      client_id: string;
    };
    const page = async (scope: string) =>
      (await fetch(authorizeUrl(base, clientId, { scope }))).text();
    const shellLine = "Shell access: runs commands on this machine as the node's user.";
    expect(await page("app.shell.*")).toContain(shellLine);
    expect(await page("app.shell.run")).toContain(shellLine);
    expect(await page("threads.read")).not.toContain(shellLine);
  });

  it("refuses a DPoP-bound device token at /mcp, where no proof is sent (security.md D1366)", async () => {
    const { kernel, base } = await startNode();
    const { privateKey, publicKey } = Crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = part({ typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } });
    const payload = part({
      htm: "POST",
      htu: `${base}/auth/pair`,
      jti: Crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    });
    const signature = Crypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const { code } = (await kernel.commands.execute("auth.pairing.create", {})) as {
      code: string;
    };
    const paired = await fetch(`${base}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", dpop: `${header}.${payload}.${signature}` },
      body: JSON.stringify({ code }),
    });
    const { token, tokenType } = (await paired.json()) as { token: string; tokenType: string };
    expect(tokenType).toBe("DPoP");
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
  });

  it("issues what the access level the approver picked grants (security.md D1369)", async () => {
    const { kernel, base, token } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as {
      client_id: string;
    };
    const cookie = await sessionCookie(base, token);
    const approve = async (access: string | undefined, scope: string) => {
      const html = await (
        await fetch(authorizeUrl(base, clientId, { scope }), { headers: { cookie } })
      ).text();
      const { access: _chosen, ...form } = formOf(html);
      return fetch(`${base}/oauth/mcp/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
        body: new URLSearchParams({
          ...form,
          ...(access === undefined ? {} : { access }),
          decision: "approve",
        }),
      });
    };
    const scopeOf = async (approved: Response) => {
      expect(approved.status).toBe(303);
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      const exchanged = await fetch(`${base}/oauth/mcp/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT.replace("33418", "40000"),
          code_verifier: verifier,
          resource: `${base}/mcp`,
        }),
      });
      return ((await exchanged.json()) as { scope: string }).scope;
    };
    expect(await scopeOf(await approve("approval-required", "threads.read threads.write"))).toBe(
      "threads.read threads.write threads.mode.approval-required",
    );
    expect(await scopeOf(await approve("read-only", "threads.read threads.write"))).toBe(
      "threads.read",
    );
    // No level, an unknown one, or read only of nothing readable issues nothing.
    expect((await approve(undefined, "threads.read")).status).toBe(400);
    expect((await approve("auto", "threads.read")).status).toBe(400);
    expect((await approve("read-only", "threads.write")).status).toBe(400);
    // A pattern keeps the level's ceiling beside it, which it never lifts
    // (D1370, agent-api's modes.test.ts).
    expect(await scopeOf(await approve("approval-required", "threads.*"))).toBe(
      "threads.* threads.mode.approval-required",
    );

    // A session gives only what it holds, the ceiling included, and says what it lacks.
    const { token: narrow } = (await kernel.commands.execute("auth.tokens.issue", {
      label: "narrow",
      permissions: ["auth.write", "threads.read", "threads.write"],
    })) as { token: string };
    const narrowCookie = await sessionCookie(base, narrow);
    const html = await (
      await fetch(authorizeUrl(base, clientId, { scope: "threads.read threads.write" }), {
        headers: { cookie: narrowCookie },
      })
    ).text();
    const { access: _chosen, ...form } = formOf(html);
    const refused = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: narrowCookie,
        origin: base,
      },
      body: new URLSearchParams({ ...form, access: "approval-required", decision: "approve" }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(
      "This session cannot grant threads.mode.approval-required",
    );
  });

  it("never lets a session approve more than it holds, nor without auth.write", async () => {
    const { kernel, base } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
    const narrow = (await kernel.commands.execute("auth.tokens.issue", {
      label: "reader",
      permissions: ["threads.read", "auth.write"],
    })) as { token: string };
    const cookie = await sessionCookie(base, narrow.token);
    const page = await (
      await fetch(authorizeUrl(base, clientId, { scope: "threads.read git.write" }), {
        headers: { cookie },
      })
    ).text();
    expect(page).not.toContain('value="approve"');
    expect(page).toContain("does not hold git.write");

    const noWrite = (await kernel.commands.execute("auth.tokens.issue", {
      label: "viewer",
      permissions: ["threads.read"],
    })) as { token: string };
    const viewer = await sessionCookie(base, noWrite.token);
    const refused = await (
      await fetch(authorizeUrl(base, clientId, { scope: "threads.read" }), {
        headers: { cookie: viewer },
      })
    ).text();
    expect(refused).toContain("does not hold auth.write");
  });

  it("shows untrusted clients and redirects on the page, and sends other errors back", async () => {
    const { base } = await startNode();
    const unknown = await fetch(authorizeUrl(base, "forged.client"), { redirect: "manual" });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("names an unknown app");

    const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
    const elsewhere = await fetch(
      authorizeUrl(base, clientId, { redirect_uri: "https://evil.example/cb" }),
      { redirect: "manual" },
    );
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain("did not register");

    const plain = await fetch(authorizeUrl(base, clientId, { code_challenge_method: "plain" }), {
      redirect: "manual",
    });
    expect(plain.status).toBe(303);
    const back = new URL(plain.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("st-1");

    const otherResource = await fetch(
      authorizeUrl(base, clientId, { resource: "https://other.example/mcp" }),
      { redirect: "manual" },
    );
    expect(new URL(otherResource.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_target",
    );

    const denied = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({
        ...Object.fromEntries(new URL(authorizeUrl(base, clientId)).searchParams),
        decision: "deny",
      }),
    });
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("refuses every mismatched exchange, and spends the code on the first", async () => {
    const { base, token } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
    const { client_id: otherClient } = (await (
      await register(base, { client_name: "Other" })
    ).json()) as { client_id: string };
    const cookie = await sessionCookie(base, token);
    const approve = async () => {
      const html = await (
        await fetch(authorizeUrl(base, clientId, { scope: "threads.read" }), {
          headers: { cookie },
        })
      ).text();
      const approved = await fetch(`${base}/oauth/mcp/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
        body: new URLSearchParams({ ...formOf(html), decision: "approve" }),
      });
      return new URL(approved.headers.get("location")!).searchParams.get("code")!;
    };
    const exchange = (code: string, body: Record<string, string>) =>
      fetch(`${base}/oauth/mcp/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT.replace("33418", "40000"),
          code_verifier: verifier,
          ...body,
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
    for (const wrong of [
      { code_verifier: Crypto.randomBytes(48).toString("base64url") },
      { redirect_uri: REDIRECT.replace("33418", "40001").replace("callback", "other") },
      { client_id: otherClient },
      { resource: "https://other.example/mcp" },
    ]) {
      const code = await approve();
      expect(await exchange(code, wrong)).toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });
      // Spent by the failed attempt (RFC 6749 §4.1.2).
      expect(await exchange(code, {})).toMatchObject({ body: { error: "invalid_grant" } });
    }
    expect(await exchange("x", { grant_type: "password" })).toMatchObject({
      body: { error: "unsupported_grant_type" },
    });
    expect(await exchange("x", { client_id: "forged.client" })).toMatchObject({
      status: 401,
      body: { error: "invalid_client" },
    });
  });

  it("issues a token that never outlives who approved it", async () => {
    const { kernel, base } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
    const approverToken = (await kernel.commands.execute("auth.tokens.issue", {
      label: "short",
      permissions: ["threads.read", "auth.write"],
      ttlDays: 1,
    })) as { token: string; expiresAt: number };
    const cookie = await sessionCookie(base, approverToken.token);
    const html = await (
      await fetch(authorizeUrl(base, clientId, { scope: "threads.read" }), { headers: { cookie } })
    ).text();
    const approved = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
      body: new URLSearchParams({ ...formOf(html), decision: "approve" }),
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const issued = (await (
      await fetch(`${base}/oauth/mcp/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT.replace("33418", "40000"),
          code_verifier: verifier,
        }),
      })
    ).json()) as { expires_in: number };
    expect(issued.expires_in).toBeLessThanOrEqual(86_400);
  });

  it("never offers * or auth.* to an MCP client", async () => {
    const { base } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
    for (const scope of ["*", "auth.write", "auth.*", "threads.read auth.admin"]) {
      const refused = await fetch(authorizeUrl(base, clientId, { scope }), { redirect: "manual" });
      expect(refused.status).toBe(303);
      expect(new URL(refused.headers.get("location")!).searchParams.get("error")).toBe(
        "invalid_scope",
      );
    }
  });

  it("issues nothing when the approver is revoked before the code is exchanged", async () => {
    const { kernel, base } = await startNode();
    const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
    const approverToken = (await kernel.commands.execute("auth.tokens.issue", {
      label: "approver",
      permissions: ["threads.read", "auth.write"],
    })) as { id: string; token: string };
    const cookie = await sessionCookie(base, approverToken.token);
    const html = await (
      await fetch(authorizeUrl(base, clientId, { scope: "threads.read" }), { headers: { cookie } })
    ).text();
    const approved = await fetch(`${base}/oauth/mcp/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
      body: new URLSearchParams({ ...formOf(html), decision: "approve" }),
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    // The session goes with the token that opened it (D421).
    await kernel.commands.execute("auth.clients.revoke", { id: approverToken.id });
    const exchanged = await fetch(`${base}/oauth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT.replace("33418", "40000"),
        code_verifier: verifier,
      }),
    });
    expect(exchanged.status).toBe(400);
    expect(await exchanged.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("names https URLs behind a local TLS proxy, and http otherwise", async () => {
    const { base } = await startNode();
    const plain = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as {
      issuer: string;
    };
    expect(plain.issuer).toBe(base);
    // From loopback (Tailscale Serve, a local proxy) X-Forwarded-Proto counts.
    const proxied = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`, {
        headers: { "x-forwarded-proto": "https" },
      })
    ).json()) as { issuer: string };
    expect(proxied.issuer).toBe(base.replace(/^http:/, "https:"));
  });

  it("registers clients statelessly within T3's bounds", async () => {
    const { base } = await startNode();
    const huge = await fetch(`${base}/oauth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x".repeat(20_000), redirect_uris: [REDIRECT] }),
    });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: "invalid_request" });
    const many = await register(base, {
      redirect_uris: Array.from({ length: 6 }, (_, index) => `http://localhost:${index + 1}/cb`),
    });
    expect(many.status).toBe(400);
    expect(await many.json()).toMatchObject({ error: "invalid_redirect_uri" });
    const remote = await register(base, { redirect_uris: ["http://evil.example/cb"] });
    expect(remote.status).toBe(400);
    const named = (await (await register(base, { client_name: "x".repeat(300) })).json()) as {
      client_name: string;
      token_endpoint_auth_method: string;
    };
    expect(named.client_name).toHaveLength(100);
    expect(named.token_endpoint_auth_method).toBe("none");
  });
});

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
}

/** Registers a client and signs it in, approved by `approver`'s page session (read only). */
async function signIn(
  base: string,
  approver: string,
  scope = "threads.read git.read",
): Promise<{ clientId: string; tokens: Tokens }> {
  const { client_id: clientId } = (await (await register(base)).json()) as { client_id: string };
  const cookie = await sessionCookie(base, approver);
  const html = await (
    await fetch(authorizeUrl(base, clientId, { scope }), { headers: { cookie } })
  ).text();
  const approved = await fetch(`${base}/oauth/mcp/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
    body: new URLSearchParams({ ...formOf(html), decision: "approve" }),
  });
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const exchanged = await fetch(`${base}/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT.replace("33418", "40000"),
      code_verifier: verifier,
    }),
  });
  expect(exchanged.status).toBe(200);
  return { clientId, tokens: (await exchanged.json()) as Tokens };
}

async function refreshWith(
  base: string,
  clientId: string,
  refreshToken: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: Tokens & { error?: string } }> {
  const response = await fetch(`${base}/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      ...extra,
    }),
  });
  return { status: response.status, body: (await response.json()) as Tokens & { error?: string } };
}

/** Whether `/mcp` still takes the access token (D414). */
async function accepted(base: string, accessToken: string): Promise<boolean> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: "{}",
  });
  return response.status !== 401;
}

const DAY_MS = 86_400_000;

describe("MCP OAuth refresh tokens (security.md D1519)", () => {
  it("answers a code with a refresh token, and a refresh renews, revokes and rotates", async () => {
    const { base, token } = await startNode();
    const { clientId, tokens } = await signIn(base, token);
    expect(tokens.scope).toBe("threads.read git.read");
    expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const renewed = await refreshWith(base, clientId, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    expect(renewed.body).toMatchObject({ token_type: "Bearer", scope: "threads.read git.read" });
    expect(renewed.body.access_token).toMatch(/^jhd1\./);
    expect(renewed.body.access_token).not.toBe(tokens.access_token);
    expect(renewed.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(renewed.body.expires_in).toBeGreaterThan(29 * 86_400);
    // The token it renews is revoked; the new one works.
    expect(await accepted(base, tokens.access_token)).toBe(false);
    expect(await accepted(base, renewed.body.access_token)).toBe(true);
    // Rotated again with the new refresh token.
    expect((await refreshWith(base, clientId, renewed.body.refresh_token)).status).toBe(200);
  });

  it("narrows the scope on request and refuses a wider one", async () => {
    const { base, token } = await startNode();
    const { clientId, tokens } = await signIn(base, token);
    const wider = await refreshWith(base, clientId, tokens.refresh_token, {
      scope: "threads.read threads.write",
    });
    expect(wider).toMatchObject({ status: 400, body: { error: "invalid_scope" } });
    // Refused for its scope, the token is not spent.
    const narrowed = await refreshWith(base, clientId, tokens.refresh_token, {
      scope: "threads.read",
    });
    expect(narrowed).toMatchObject({ status: 200, body: { scope: "threads.read" } });
    // The refresh token keeps the granted scope (OAuth 2.1 §4.3.1).
    const again = await refreshWith(base, clientId, narrowed.body.refresh_token);
    expect(again.body.scope).toBe("threads.read git.read");
  });

  it("refuses another client, and a forged one", async () => {
    const { base, token } = await startNode();
    const { tokens } = await signIn(base, token);
    const { client_id: other } = (await (
      await register(base, { client_name: "Other" })
    ).json()) as { client_id: string };
    expect(await refreshWith(base, other, tokens.refresh_token)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(await refreshWith(base, "forged.client", tokens.refresh_token)).toMatchObject({
      status: 401,
      body: { error: "invalid_client" },
    });
    expect(await refreshWith(base, other, "not-a-token")).toMatchObject({
      body: { error: "invalid_grant" },
    });
  });

  it("ends the sign-in when its access token is revoked under Authorized clients", async () => {
    const { kernel, base, token } = await startNode();
    const { clientId, tokens } = await signIn(base, token);
    const { clients } = (await kernel.commands.execute("auth.clients.list", {})) as {
      clients: { id: string; method: string }[];
    };
    const client = clients.find((entry) => entry.method === "oauth")!;
    await kernel.commands.execute("auth.clients.revoke", { id: client.id });
    expect(await refreshWith(base, clientId, tokens.refresh_token)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
  });

  it("ends the sign-in when whoever approved it is revoked", async () => {
    const { kernel, base } = await startNode();
    const approver = (await kernel.commands.execute("auth.tokens.issue", {
      label: "approver",
      permissions: ["threads.read", "git.read", "auth.write"],
    })) as { id: string; token: string };
    const { clientId, tokens } = await signIn(base, approver.token);
    expect((await refreshWith(base, clientId, tokens.refresh_token)).status).toBe(200);
    const { clientId: second, tokens: secondTokens } = await signIn(base, approver.token);
    await kernel.commands.execute("auth.clients.revoke", { id: approver.id });
    expect(await refreshWith(base, second, secondTokens.refresh_token)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
  });

  it("revokes the sign-in's current tokens when a spent refresh token comes back", async () => {
    const { base, token } = await startNode();
    const { clientId, tokens } = await signIn(base, token);
    const first = await refreshWith(base, clientId, tokens.refresh_token);
    const second = await refreshWith(base, clientId, first.body.refresh_token);
    expect(second.status).toBe(200);
    // The first refresh token again: one of its two holders stole it (RFC 9700 §4.14.2).
    expect(await refreshWith(base, clientId, tokens.refresh_token)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(await accepted(base, second.body.access_token)).toBe(false);
    expect(await refreshWith(base, clientId, second.body.refresh_token)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
  });

  it("renews an expired access token, and expires 90 days after its issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { kernel, base, token } = await startNode();
    const { clientId, tokens } = await signIn(base, token);
    vi.setSystemTime(Date.now() + 31 * DAY_MS);
    expect(await accepted(base, tokens.access_token)).toBe(false);
    // Issuing drops the expired access token from the list: gone because it
    // expired, not because it was revoked, so the refresh still renews it.
    await kernel.commands.execute("auth.tokens.issue", {
      label: "other",
      permissions: ["threads.read"],
    });
    const renewed = await refreshWith(base, clientId, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    expect(await accepted(base, renewed.body.access_token)).toBe(true);

    // 90 days from its own issue, the rotated refresh token is spent by time.
    vi.setSystemTime(Date.now() + 90 * DAY_MS + 1);
    expect(await refreshWith(base, clientId, renewed.body.refresh_token)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
  });

  it("keeps refresh tokens across a restart, as hashes in a 0600 refresh.json", async () => {
    const { kernel, base, token, data } = await startNode();
    const { clientId, tokens } = await signIn(base, token);
    const file = Path.join(data, "jhin.mcp-oauth", "refresh.json");
    const text = Fs.readFileSync(file, "utf8");
    expect(text).not.toContain(tokens.refresh_token);
    expect(text).toContain(
      Crypto.createHash("sha256").update(tokens.refresh_token).digest("base64url"),
    );
    if (process.platform !== "win32") expect(Fs.statSync(file).mode & 0o777).toBe(0o600);

    await kernel.reload("jhin.mcp-oauth");
    const renewed = await refreshWith(base, clientId, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    expect(Fs.readFileSync(file, "utf8")).not.toContain(renewed.body.refresh_token);
  });
});
