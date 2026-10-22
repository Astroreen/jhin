import { describe, expect, it } from "vite-plus/test";

import {
  appendKeepingNewest,
  createMemoryStorage,
  keepNewest,
  type EventLog,
} from "../src/index.ts";

const event = (n: number) => ({ type: "app.a", payload: n });
const sequences = async (log: EventLog) => (await log.read("s")).map((item) => item.sequence);

describe("keeping the newest events of a stream (D497)", () => {
  it("trims when an append ends on a multiple of `every`, and only then", async () => {
    const { log } = createMemoryStorage();
    const errors: unknown[] = [];
    const options = { keep: 3, every: 5, onTrimError: (error: unknown) => errors.push(error) };
    for (let n = 1; n <= 4; n += 1) await appendKeepingNewest(log, "s", [event(n)], options);
    expect(await sequences(log)).toEqual([1, 2, 3, 4]);
    await appendKeepingNewest(log, "s", [event(5)], options);
    expect(await sequences(log)).toEqual([3, 4, 5]);
    await appendKeepingNewest(log, "s", [event(6)], options);
    expect(await sequences(log)).toEqual([3, 4, 5, 6]);
    // A batch that steps over 10 without ending on it trims too.
    await appendKeepingNewest(log, "s", [7, 8, 9, 10, 11].map(event), options);
    expect(await sequences(log)).toEqual([9, 10, 11]);
    expect(errors).toEqual([]);
  });

  it("keeps the append when the trim fails, and reports why", async () => {
    const storage = createMemoryStorage();
    const log: EventLog = { ...storage.log, trim: () => Promise.reject(new Error("disk")) };
    const errors: unknown[] = [];
    const stored = await appendKeepingNewest(log, "s", [1, 2].map(event), {
      keep: 1,
      every: 2,
      onTrimError: (error) => errors.push(error),
    });
    expect(stored.map((item) => item.sequence)).toEqual([1, 2]);
    expect(errors).toMatchObject([{ message: "disk" }]);
  });

  it("trims nothing on a provider without trim (1.0)", async () => {
    const { trim: _trim, ...older } = createMemoryStorage().log;
    await older.append("s", [1, 2, 3].map(event));
    expect(await keepNewest(older, "s", 1)).toBe(0);
    expect(await sequences(older)).toEqual([1, 2, 3]);
  });
});
