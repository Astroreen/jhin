import { afterEach, describe, expect, it } from "vite-plus/test";

import { createClient, type Clock } from "../src/client.ts";
import { fakeOpenCode } from "./fake-server.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Runs every wait at once and counts them. */
function instant() {
  const waits: number[] = [];
  const clock: Clock = {
    after(ms, run) {
      waits.push(ms);
      queueMicrotask(run);
      return () => {};
    },
  };
  return { clock, waits };
}

describe("jhin.agent-opencode: the client", () => {
  it("asks again while a directory's plugins activate", async () => {
    const fake = await fakeOpenCode({ unavailable: 2 });
    cleanups.push(() => fake.close());
    const { clock, waits } = instant();
    const client = createClient({ url: fake.url, clock });
    expect(await client.models("/work")).toHaveLength(2);
    expect(waits).toEqual([500, 500]);
    expect(fake.calls("GET", "/api/model")).toHaveLength(3);
  });

  it("gives up after a minute of waiting", async () => {
    const fake = await fakeOpenCode({ unavailable: 1_000 });
    cleanups.push(() => fake.close());
    const { clock, waits } = instant();
    const client = createClient({ url: fake.url, clock });
    await expect(client.models("/work")).rejects.toMatchObject({
      tag: "ServiceUnavailableError",
      message: "Location plugins did not finish activating",
    });
    expect(waits).toHaveLength(120);
  });
});
