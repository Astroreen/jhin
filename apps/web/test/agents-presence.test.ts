import { describe, expect, it } from "vite-plus/test";

import { hasAgents } from "../src/lib/agents-presence.ts";

const answering = (answer: () => Promise<unknown>) => ({
  call: <T>() => answer() as Promise<T>,
});
const failing = (code: string) =>
  answering(() => Promise.reject(Object.assign(new Error(code), { code })));

describe("hasAgents (D747)", () => {
  it("tells a node with a defined agent from one without", async () => {
    expect(await hasAgents(answering(async () => ({ head: 1, agents: [{ id: "lead" }] })))).toBe(
      true,
    );
    expect(await hasAgents(answering(async () => ({ head: 0, agents: [] })))).toBe(false);
  });

  it("reads a missing agents plugin as no agents, and any other failure as not known", async () => {
    expect(await hasAgents(failing("COMMAND_NOT_FOUND"))).toBe(false);
    expect(await hasAgents(failing("PERMISSION_DENIED"))).toBe(false);
    expect(await hasAgents(failing("TIMEOUT"))).toBeUndefined();
  });
});
