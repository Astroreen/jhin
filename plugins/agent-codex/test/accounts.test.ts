import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { materializeShadowHome } from "../src/accounts.ts";
import { CODEX_AGENT_ID, Config } from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until } from "./support.ts";

afterEach(stopAll);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) Fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-codex-accounts-"));
  dirs.push(dir);
  return dir;
};

describe("jhin.agent-codex: a shadow home (D1319)", () => {
  it("links the main home in, keeping the account's sign-in its own", () => {
    const root = tempDir();
    const shared = Path.join(root, "codex");
    const shadow = Path.join(root, "work");
    Fs.mkdirSync(shared);
    Fs.writeFileSync(Path.join(shared, "config.toml"), "model = 'x'\n");
    Fs.writeFileSync(Path.join(shared, "auth.json"), '{"main":true}');
    Fs.writeFileSync(Path.join(shared, "models_cache.json"), "{}");
    Fs.mkdirSync(Path.join(shared, "log"));
    Fs.mkdirSync(shadow);
    Fs.writeFileSync(Path.join(shadow, "auth.json"), '{"work":true}');
    // A lock Codex made itself in the shadow home goes for the shared one.
    Fs.mkdirSync(Path.join(shadow, "mcp-oauth-locks"));

    materializeShadowHome(shared, shadow);

    expect(Fs.readlinkSync(Path.join(shadow, "config.toml"))).toBe(
      Path.join(shared, "config.toml"),
    );
    expect(Fs.readlinkSync(Path.join(shadow, "sessions"))).toBe(Path.join(shared, "sessions"));
    expect(Fs.readlinkSync(Path.join(shadow, "mcp-oauth-locks"))).toBe(
      Path.join(shared, "mcp-oauth-locks"),
    );
    // The account's own files and the home-local ones are not linked.
    expect(Fs.readFileSync(Path.join(shadow, "auth.json"), "utf8")).toBe('{"work":true}');
    expect(Fs.existsSync(Path.join(shadow, "models_cache.json"))).toBe(false);
    expect(Fs.existsSync(Path.join(shadow, "log"))).toBe(false);
    // An entry the main home lost leaves no dangling link behind.
    Fs.rmSync(Path.join(shared, "config.toml"));
    materializeShadowHome(shared, shadow);
    expect(Fs.existsSync(Path.join(shadow, "config.toml"))).toBe(false);
    expect(() => Fs.readlinkSync(Path.join(shadow, "config.toml"))).toThrow();
    // Run again: nothing changes, and an entry the main home gained is linked.
    Fs.writeFileSync(Path.join(shared, "AGENTS.md"), "# notes\n");
    materializeShadowHome(shared, shadow);
    expect(Fs.readlinkSync(Path.join(shadow, "AGENTS.md"))).toBe(Path.join(shared, "AGENTS.md"));
  });

  it("refuses the main home itself, a file in a link's place and a linked sign-in", () => {
    const root = tempDir();
    const shared = Path.join(root, "codex");
    Fs.mkdirSync(shared);
    expect(() => materializeShadowHome(shared, shared)).toThrow(/must be different/);
    // Inside the main home, or holding it: a home linked into itself.
    expect(() => materializeShadowHome(shared, Path.join(shared, "work"))).toThrow(/inside/);
    expect(() =>
      materializeShadowHome(Path.join(root, "outer", "codex"), Path.join(root, "outer")),
    ).toThrow(/inside/);
    const shadow = Path.join(root, "work");
    Fs.mkdirSync(shadow);
    Fs.writeFileSync(Path.join(shared, "config.toml"), "");
    Fs.writeFileSync(Path.join(shadow, "config.toml"), "mine");
    expect(() => materializeShadowHome(shared, shadow)).toThrow(/is not a symlink/);
    Fs.rmSync(Path.join(shadow, "config.toml"));
    Fs.writeFileSync(Path.join(shared, "auth.json"), "{}");
    Fs.symlinkSync(Path.join(shared, "auth.json"), Path.join(shadow, "auth.json"));
    expect(() => materializeShadowHome(shared, shadow)).toThrow(/must be a real file/);
  });
});

describe("jhin.agent-codex: more accounts (D1319)", () => {
  it("runs each account as an agent of its own over its shadow home", async () => {
    const root = tempDir();
    const shared = Path.join(root, "codex");
    const workHome = Path.join(root, "work");
    const fake = fakeCodex({});
    const { client, kernel } = await node(fake, {
      homePath: shared,
      accounts: [{ id: "work", name: "Work", homePath: workHome }],
    });
    const agents = await client.call<{ agentId: string; name: string }[]>("agents.list");
    expect(agents.map((agent) => [agent.agentId, agent.name])).toEqual(
      expect.arrayContaining([
        [CODEX_AGENT_ID, "Codex"],
        [`${CODEX_AGENT_ID}:work`, "Codex · Work"],
      ]),
    );
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: `${CODEX_AGENT_ID}:work`,
    });
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    const events = await done;
    expect(payloads(events, "agent.turn.started")[0]).toMatchObject({
      agentId: `${CODEX_AGENT_ID}:work`,
    });
    // Its Codex ran in the shadow home, linked over the main one.
    const started = fake.log().filter((entry) => entry["started"] !== undefined);
    expect(started.map((entry) => entry["home"])).toContain(workHome);
    expect(Fs.readlinkSync(Path.join(workHome, "sessions"))).toBe(Path.join(shared, "sessions"));

    // Its running Codex is one of the node's, and goes with its thread.
    const listed = await client.call<{ threadId: string }[]>("codex.sessions.list", {});
    expect(listed.map((entry) => entry.threadId)).toContain(thread.id);
    await client.call("threads.delete", { threadId: thread.id });
    const after = await client.call<{ threadId: string }[]>("codex.sessions.list", {});
    expect(after.map((entry) => entry.threadId)).not.toContain(thread.id);

    // Removed from the config, the account's agent goes.
    kernel.config.setLayer("node", { "jhin.agent-codex": { ...fake.config, homePath: shared } });
    const listedAgents = await client.call<{ agentId: string }[]>("agents.list");
    expect(listedAgents.map((agent) => agent.agentId)).not.toContain(`${CODEX_AGENT_ID}:work`);
  });

  it("refuses two accounts with one id or one home, and fails a turn whose home cannot be made", async () => {
    const root = tempDir();
    const shared = Path.join(root, "codex");
    expect(
      Config.safeParse({
        accounts: [
          { id: "a", name: "A", homePath: Path.join(root, "a") },
          { id: "a", name: "B", homePath: Path.join(root, "a") },
        ],
      }).error?.issues.map((issue) => issue.message),
    ).toEqual(["Another account has this id", "Another account has this home"]);
    // A home inside the main one: the turn fails saying why.
    const fake = fakeCodex({});
    const { client } = await node(fake, {
      homePath: shared,
      accounts: [{ id: "bad", name: "Bad", homePath: Path.join(shared, "bad") }],
    });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: `${CODEX_AGENT_ID}:bad`,
    });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    expect(String(payloads(await failed, "agent.turn.failed")[0]?.["error"])).toContain(
      "must not be inside the shared home path",
    );
  });
});
