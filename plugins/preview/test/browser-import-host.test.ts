// The import's runs of the machine's programs (D1204).
import { describe, expect, it } from "vite-plus/test";

import { isAborted, runProgram, sharingRuns, type RunResult } from "../src/browser-import/host.ts";
import { fakeHost, ran } from "./browser-import-fixtures.ts";

describe("runProgram", () => {
  it("kills a program its signal aborts, as an unanswered prompt", async () => {
    const controller = new AbortController();
    // A program that never ends by itself.
    const running = runProgram(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      signal: controller.signal,
    });
    controller.abort();
    const error = await running.catch((cause: unknown) => cause);
    expect(isAborted(error)).toBe(true);
  });
});

describe("sharingRuns", () => {
  it("runs one program for identical runs going on at once, and a new one after", async () => {
    let finish: (result: RunResult) => void = () => {};
    const host = fakeHost({
      platform: "darwin",
      home: "/Users/u",
      run: () => new Promise<RunResult>((resolve) => (finish = resolve)),
    });
    const shared = sharingRuns(host);
    const args = ["find-generic-password", "-w"];
    const first = shared.run("/usr/bin/security", args);
    const second = shared.run("/usr/bin/security", args);
    expect(host.calls).toHaveLength(1);
    finish(ran(0, "secret\n"));
    expect((await first).stdout.toString()).toBe("secret\n");
    expect(await second).toBe(await first);
    void shared.run("/usr/bin/security", args);
    expect(host.calls).toHaveLength(2);
  });
});
