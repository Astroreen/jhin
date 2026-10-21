import { SOURCE_CONTROL_STREAM } from "@jhin/source-control-api";
import { memoryStoragePlugin } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { HISTORY } from "../src/index.ts";
import { node } from "./support.ts";

describe("jhin.source-control: the stream's history (D497)", () => {
  it("keeps the newest events of the source-control stream, and its head", async () => {
    const storage = memoryStoragePlugin();
    const log = storage.storage.log;
    await log.append(
      SOURCE_CONTROL_STREAM,
      Array.from({ length: HISTORY + 150 }, (_, index) => ({
        type: "source-control.project.removed",
        payload: { projectId: `p-${index}` },
      })),
    );

    // Records each trim: where the stream's head was, what it cut, and when it finished.
    const order: string[] = [];
    const trims: { head: number; through: number; forgot: number }[] = [];
    const trim = log.trim!.bind(log);
    log.trim = async (stream, through) => {
      const head = await log.head(stream);
      const forgot = await trim(stream, through);
      trims.push({ head, through, forgot });
      order.push("trimmed");
      return forgot;
    };

    const sc = await node({}, { storage });
    const snapshot = await sc.status();
    order.push("status");

    // One trim at start, down to the newest HISTORY events, finished before the first status.
    expect(trims[0]).toEqual({
      head: trims[0]!.head,
      through: trims[0]!.head - HISTORY,
      forgot: trims[0]!.head - HISTORY,
    });
    expect(trims[0]!.head).toBeGreaterThanOrEqual(HISTORY + 150);
    expect(order.indexOf("trimmed")).toBeLessThan(order.indexOf("status"));
    // What the trim kept is still there, numbered as before, and git.status's head lies in it.
    const kept = (await log.read(SOURCE_CONTROL_STREAM)).map((event) => event.sequence);
    expect(kept[0]).toBe(trims[0]!.through + 1);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, index) => kept[0]! + index));
    expect(snapshot.head).toBeGreaterThanOrEqual(trims[0]!.head);
  });
});
