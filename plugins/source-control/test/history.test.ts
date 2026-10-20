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

    expect(snapshot.head).toBe(HISTORY + 150);
    // Trimmed to the newest 1000 at start; what the node appended since follows.
    const kept = await log.read(SOURCE_CONTROL_STREAM);
    expect(kept[0]?.sequence).toBe(151);
    expect(kept.map((event) => event.sequence)).toEqual(
      Array.from({ length: kept.length }, (_, index) => 151 + index),
    );
  });
});
