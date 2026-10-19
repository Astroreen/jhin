import { configComments } from "@jhin/kernel";
import { describe, expect, it } from "vite-plus/test";

describe("comments above config keys (D81)", () => {
  it("reads the comment directly above each key of the section, the section's own included", () => {
    const text = `{
  // The HTTP server.
  "jhin.http": {
    // Interface to listen on.
    "host": "0.0.0.0",
    /** 0 picks a free port. */
    "port": 0,
    "trustProxy": [],
  },
  // Another section's key is not this section's.
  "jhin.mesh": { "name": "a" }
}`;
    expect(configComments(text, "jhin.http")).toEqual([
      { path: [], text: "The HTTP server." },
      { path: ["host"], text: "Interface to listen on." },
      { path: ["port"], text: "0 picks a free port." },
    ]);
  });

  it("joins the lines of a paragraph and keeps paragraphs apart", () => {
    const text = `{
  "s": {
    // Reverse proxies whose
    // forwarded header names the client.
    //
    // Empty by default.
    "trust": [],
    /**
     * A JSDoc block,
     * over two lines.
     */
    "block": 1
  }
}`;
    expect(configComments(text, "s")).toEqual([
      {
        path: ["trust"],
        text: "Reverse proxies whose forwarded header names the client.\n\nEmpty by default.",
      },
      { path: ["block"], text: "A JSDoc block, over two lines." },
    ]);
  });

  it("ignores a comment after a value on the same line, and one a blank line away", () => {
    const text = `{
  "s": {
    "a": 1, // about a, not b
    "b": 2,
    // far from c

    "c": 3,
    // first run

    // the run right above d
    "d": 4
  }
}`;
    expect(configComments(text, "s")).toEqual([{ path: ["d"], text: "the run right above d" }]);
  });

  it("reads nested keys with their path and skips keys inside arrays", () => {
    const text = `{
  "s": {
    "group": {
      // inner
      "flag": true
    },
    "rules": [
      {
        // in an array
        "key": "x"
      }
    ]
  }
}`;
    expect(configComments(text, "s")).toEqual([{ path: ["group", "flag"], text: "inner" }]);
  });

  it("gives nothing for a file without the section or without comments", () => {
    expect(configComments("", "s")).toEqual([]);
    expect(configComments('{ "s": { "a": 1 } }', "s")).toEqual([]);
    expect(configComments('{ "t": { /* x */ "a": 1 } }', "s")).toEqual([]);
  });
});
