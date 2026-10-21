import { describe, expect, it } from "vite-plus/test";

import { secretRequestFailureMessage } from "../src/plugins/secrets/failure.ts";

describe("a secret request's failure (security.md D1032)", () => {
  it("shows the node's own refusals", () => {
    expect(
      secretRequestFailureMessage({
        code: "SECRET_REQUEST_ANSWERED",
        message: "This secret request was already answered.",
      }),
    ).toBe("This secret request was already answered.");
  });

  it("shows nothing else, so a typed value cannot surface", () => {
    expect(
      secretRequestFailureMessage({
        code: "COMMAND_INPUT_INVALID",
        message: "Invalid input: hunter2",
      }),
    ).toBe("Could not answer the request. Try again.");
    expect(secretRequestFailureMessage(new Error("socket closed"))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
