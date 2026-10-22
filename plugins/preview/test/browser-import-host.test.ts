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

  it("survives a program that exits before reading its input (EPIPE)", async () => {
    // More input than a pipe holds, to a program that never reads it.
    const result = await runProgram(process.execPath, ["-e", "process.exit(3)"], {
      stdin: "x".repeat(4 * 1024 * 1024),
    });
    expect(result.exitCode).toBe(3);
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

  it("gives each caller its own deadline, and stops the program once nobody waits", async () => {
    let finish: (result: RunResult) => void = () => {};
    const host = fakeHost({
      platform: "darwin",
      home: "/Users/u",
      run: () => new Promise<RunResult>((resolve) => (finish = resolve)),
    });
    const shared = sharingRuns(host);
    const args = ["find-generic-password", "-w"];
    const first = new AbortController();
    const second = new AbortController();
    const firstRun = shared.run("/usr/bin/security", args, { signal: first.signal });
    const secondRun = shared.run("/usr/bin/security", args, { signal: second.signal });
    const program = host.calls[0]?.signal;
    expect(host.calls).toHaveLength(1);

    // The first caller's deadline ends its wait only.
    first.abort();
    expect(isAborted(await firstRun.catch((cause: unknown) => cause))).toBe(true);
    expect(program?.aborted).toBe(false);
    finish(ran(0, "secret"));
    expect((await secondRun).stdout.toString()).toBe("secret");

    // When every caller gave up, the prompt is killed.
    const third = new AbortController();
    const thirdRun = shared.run("/usr/bin/security", args, { signal: third.signal });
    third.abort();
    expect(isAborted(await thirdRun.catch((cause: unknown) => cause))).toBe(true);
    expect(host.calls[1]?.signal?.aborted).toBe(true);
  });

  it("never shares a run with input, so no secret becomes a key", async () => {
    const host = fakeHost({ platform: "win32", home: "C:\\Users\\u", run: () => ran(0, "k") });
    const shared = sharingRuns(host);
    await Promise.all([
      shared.run("powershell.exe", ["-Command", "x"], { stdin: "wrapped" }),
      shared.run("powershell.exe", ["-Command", "x"], { stdin: "wrapped" }),
    ]);
    expect(host.calls).toHaveLength(2);
  });
});
