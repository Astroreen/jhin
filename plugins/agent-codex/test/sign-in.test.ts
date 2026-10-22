import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, stopAll } from "./support.ts";

afterEach(stopAll);

const signedOut = { account: { account: null, requiresOpenaiAuth: true } };

describe("jhin.agent-codex: signing in (D1151)", () => {
  it("signs in with a device code through Codex's own login, then looks at Codex again", async () => {
    const fake = fakeCodex({ ...signedOut, login: { success: true } });
    const { client } = await node(fake);
    const [codex] = (
      await client.call<{ agentId: string; signIn: string[]; signedIn: boolean }[]>("agents.list")
    ).filter((agent) => agent.agentId === CODEX_AGENT_ID);
    expect(codex).toMatchObject({ signIn: ["browser", "device-code"], signedIn: false });
    const started = await client.call<{ flowId: string }>("agents.sign-in.start", {
      agentId: CODEX_AGENT_ID,
      method: "device-code",
    });
    expect(started).toEqual({
      flowId: "login-1",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    expect(fake.received("account/login/start").map((call) => call.params)).toEqual([
      { type: "chatgptDeviceCode" },
    ]);
    expect(
      await client.call("agents.sign-in.wait", { agentId: CODEX_AGENT_ID, flowId: started.flowId }),
    ).toEqual({ success: true });
    // The account changed: the next look at the agents probes Codex again.
    const probes = fake.received("account/read").length;
    await client.call("agents.list");
    expect(fake.received("account/read").length).toBe(probes + 1);
  });

  it("opens Codex's browser login, cancels it and signs out", async () => {
    const fake = fakeCodex({});
    const { client } = await node(fake);
    const started = await client.call<{ flowId: string; url: string }>("agents.sign-in.start", {
      agentId: CODEX_AGENT_ID,
    });
    expect(started).toEqual({ flowId: "login-1", url: "https://auth.openai.com/oauth/login-1" });
    const waited = client.call("agents.sign-in.wait", {
      agentId: CODEX_AGENT_ID,
      flowId: started.flowId,
    });
    await client.call("agents.sign-in.cancel", { agentId: CODEX_AGENT_ID, flowId: started.flowId });
    expect(await waited).toEqual({ success: false, error: "Sign-in cancelled." });
    expect(await client.call("agents.sign-out", { agentId: CODEX_AGENT_ID })).toEqual({});
    expect(fake.received("account/logout")).toHaveLength(1);
    await expect(
      client.call("agents.sign-in.start", { agentId: "acme.none" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
