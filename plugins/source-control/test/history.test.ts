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

    const sc = await node({}, { storage });
    // The first status waits for the trim at start.
    const snapshot = await sc.status();

    // The node may append (a project read) before and after the trim; however it
    // interleaves, the stream keeps its numbering and was cut to HISTORY at the trim.
    const head = await log.head(SOURCE_CONTROL_STREAM);
    const prefilled = HISTORY + 150;
    expect(snapshot.head).toBeGreaterThanOrEqual(prefilled);
    expect(snapshot.head).toBeLessThanOrEqual(head);
    const kept = (await log.read(SOURCE_CONTROL_STREAM)).map((event) => event.sequence);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, index) => kept[0]! + index));
    expect(kept.at(-1)).toBe(head);
    // At least HISTORY kept, and no more than HISTORY plus what came after the prefill.
    expect(kept.length).toBeGreaterThanOrEqual(HISTORY);
    expect(kept.length).toBeLessThanOrEqual(HISTORY + (head - prefilled));
  });
});
