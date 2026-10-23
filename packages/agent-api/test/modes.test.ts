import { describe, expect, it } from "vite-plus/test";

import { RUNTIME_MODES, capRuntimeMode, ceilingOf } from "../src/modes.ts";

describe("a runtime mode ceiling (security.md D1370)", () => {
  it("is the highest mode the grants name, and none when they name none", () => {
    expect(ceilingOf(undefined)).toBeUndefined();
    expect(ceilingOf(["*"])).toBeUndefined();
    expect(ceilingOf(["threads.read", "threads.write"])).toBeUndefined();
    expect(ceilingOf(["threads.mode.approval-required"])).toBe("approval-required");
    expect(ceilingOf(["threads.mode.approval-required", "threads.mode.auto-accept-edits"])).toBe(
      "auto-accept-edits",
    );
  });

  it("reads RUNTIME_MODES from the narrowest to the broadest", () => {
    expect(RUNTIME_MODES).toEqual(["approval-required", "auto-accept-edits", "full-access"]);
  });

  it("is never lifted by a pattern beside it", () => {
    for (const pattern of ["*", "threads.*", "threads.mode.*"]) {
      expect(ceilingOf([pattern, "threads.mode.approval-required"]), pattern).toBe(
        "approval-required",
      );
    }
  });

  it("lowers a mode above it and keeps one below", () => {
    expect(capRuntimeMode("full-access", "approval-required")).toBe("approval-required");
    expect(capRuntimeMode("approval-required", "full-access")).toBe("approval-required");
    expect(capRuntimeMode("full-access", undefined)).toBe("full-access");
  });
});
