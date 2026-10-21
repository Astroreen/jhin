import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  isPathWord,
  parseStandaloneComposerSlashCommand,
  serializeComposerFileLink,
  serializeComposerPullRequestLink,
  serializeComposerThreadLink,
  splitPromptIntoSegments,
  submitsOnKey,
} from "../src/lib/composer-trigger.ts";

describe("the composer's trigger at the caret (D303, as T3's detectComposerTrigger)", () => {
  it("reads a slash command, its query and its range", () => {
    expect(detectComposerTrigger("/mod", 4)).toEqual({
      kind: "slash-command",
      query: "mod",
      rangeStart: 0,
      rangeEnd: 4,
    });
    expect(detectComposerTrigger("fix it /", 8)).toEqual({
      kind: "slash-command",
      query: "",
      rangeStart: 7,
      rangeEnd: 8,
    });
  });

  it("takes a slash word with a second slash for a path, wherever the caret is in it", () => {
    expect(detectComposerTrigger("/tmp/build.sh", 13)).toBeNull();
    expect(detectComposerTrigger("/tmp/build.sh", 3)).toBeNull();
    expect(isPathWord("/tmp/x", 0, 2)).toBe(true);
    expect(isPathWord("/compact", 0, 3)).toBe(false);
  });

  it("reads a skill after any currency sign", () => {
    expect(detectComposerTrigger("use $rev", 8)).toEqual({
      kind: "skill",
      query: "rev",
      rangeStart: 4,
      rangeEnd: 8,
    });
    expect(detectComposerTrigger("€", 1)).toMatchObject({ kind: "skill", query: "" });
  });

  it("reads a path after @, on any line", () => {
    expect(detectComposerTrigger("see\n@src/a", 10)).toEqual({
      kind: "path",
      query: "src/a",
      rangeStart: 4,
      rangeEnd: 10,
    });
  });

  it("reads a pull request after #: a number, words, or nothing yet", () => {
    expect(detectComposerTrigger("see #12", 7)).toEqual({
      kind: "pull-request",
      query: "12",
      rangeStart: 4,
      rangeEnd: 7,
    });
    expect(detectComposerTrigger("#", 1)).toMatchObject({ kind: "pull-request", query: "" });
    expect(detectComposerTrigger("#fix-cache", 10)).toMatchObject({ query: "fix-cache" });
    expect(detectComposerTrigger("#é", 2)).toMatchObject({ query: "é" });
    // A heading's hashes, a second #, or a query starting with a dash is not one.
    for (const prompt of ["##", "#-x", "#12#", "a#1"]) {
      expect(detectComposerTrigger(prompt, prompt.length)).toBeNull();
    }
  });

  it("sees nothing in plain words or after whitespace", () => {
    expect(detectComposerTrigger("hello", 5)).toBeNull();
    expect(detectComposerTrigger("@a ", 3)).toBeNull();
    expect(detectComposerTrigger("#12 ", 4)).toBeNull();
    expect(detectComposerTrigger("", 0)).toBeNull();
  });

  it("clamps a caret outside the prompt", () => {
    expect(detectComposerTrigger("@x", 99)).toMatchObject({ kind: "path", rangeEnd: 2 });
    expect(detectComposerTrigger("@x", Number.NaN)).toMatchObject({ kind: "path", rangeEnd: 2 });
  });
});

describe("a picked file in the prompt", () => {
  it("is a markdown link labelled with its basename", () => {
    expect(serializeComposerFileLink("src/a.ts")).toBe("[a.ts](src/a.ts)");
    expect(serializeComposerFileLink("docs/my file (1).md")).toBe(
      "[my file (1).md](docs/my%20file%20%281%29.md)",
    );
    expect(serializeComposerFileLink("a/[x].ts")).toBe("[\\[x\\].ts](a/%5Bx%5D.ts)");
  });

  it("splits back out as a mention chip with its decoded path", () => {
    const link = serializeComposerFileLink("docs/my file (1).md");
    expect(splitPromptIntoSegments(`read ${link} now`)).toEqual([
      { type: "text", text: "read " },
      { type: "mention", path: "docs/my file (1).md", source: link },
      { type: "text", text: " now" },
    ]);
  });
});

describe("the prompt's chips", () => {
  it("are file links, legacy @paths and skills, and give the prompt back unchanged", () => {
    const prompt = "[a.ts](src/a.ts) and @./lib/b.ts with $review-pr please";
    const segments = splitPromptIntoSegments(prompt);
    expect(segments).toEqual([
      { type: "mention", path: "src/a.ts", source: "[a.ts](src/a.ts)" },
      { type: "text", text: " and " },
      { type: "mention", path: "./lib/b.ts", source: "@./lib/b.ts" },
      { type: "text", text: " with " },
      { type: "skill", name: "review-pr", source: "$review-pr" },
      { type: "text", text: " please" },
    ]);
    expect(
      segments.map((segment) => ("source" in segment ? segment.source : segment.text)).join(""),
    ).toBe(prompt);
  });

  it("may end the prompt", () => {
    expect(splitPromptIntoSegments("$skill")).toEqual([
      { type: "skill", name: "skill", source: "$skill" },
    ]);
  });

  it("leave a link with another label, a URL, an amount and a package alone", () => {
    for (const prompt of [
      "[docs](src/a.ts)",
      "[x](https://example.com/x)",
      "costs $100 or $5k",
      "install @scope/pkg",
      "mid$word",
    ]) {
      expect(splitPromptIntoSegments(prompt)).toEqual([{ type: "text", text: prompt }]);
    }
  });

  it("read a quoted @path with spaces", () => {
    expect(splitPromptIntoSegments('@"my dir/a.ts" x')[0]).toEqual({
      type: "mention",
      path: "my dir/a.ts",
      source: '@"my dir/a.ts"',
    });
  });
});

describe("a picked pull request or thread in the prompt", () => {
  it("is a link labelled #number to the pull request, split back out as a reference chip", () => {
    const link = serializeComposerPullRequestLink({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
    });
    expect(link).toBe("[#12](https://github.com/acme/app/pull/12)");
    expect(splitPromptIntoSegments(`look at ${link} please`)).toEqual([
      { type: "text", text: "look at " },
      {
        type: "reference",
        kind: "pull-request",
        label: "#12",
        href: "https://github.com/acme/app/pull/12",
        source: link,
      },
      { type: "text", text: " please" },
    ]);
  });

  it("leaves a #number link to anything but that pull request as a plain link", () => {
    for (const url of [
      "https://example.com/phish",
      "https://github.com/acme/app/pull/13",
      "https://github.com/acme/app/issues/12",
    ]) {
      const kinds = splitPromptIntoSegments(`see [#12](${url})`).map((segment) =>
        "kind" in segment ? segment.kind : segment.type,
      );
      expect(kinds, url).not.toContain("pull-request");
    }
    expect(
      splitPromptIntoSegments("[#7](https://gitlab.com/a/b/-/merge_requests/7)").map((segment) =>
        "kind" in segment ? segment.kind : segment.type,
      ),
    ).toEqual(["pull-request"]);
  });

  it("is a link labelled with the thread's title to its jhin:// address", () => {
    const link = serializeComposerThreadLink(
      "  Fix [the] cache\n now ",
      "jhin://node-1/threads/t-2",
    );
    expect(link).toBe("[Fix the cache now](jhin://node-1/threads/t-2)");
    expect(serializeComposerThreadLink("[]", "jhin://n/threads/t")).toBe(
      "[thread](jhin://n/threads/t)",
    );
    expect(splitPromptIntoSegments(link)).toEqual([
      {
        type: "reference",
        kind: "thread",
        label: "Fix the cache now",
        href: "jhin://node-1/threads/t-2",
        source: link,
      },
    ]);
  });

  it("leaves other links alone: a #label to a file, another jhin:// address", () => {
    for (const prompt of ["[#12](src/a.ts)", "[agent](jhin://n/agents/a)", "#12"]) {
      expect(splitPromptIntoSegments(prompt)).toEqual([{ type: "text", text: prompt }]);
    }
  });
});

describe("sending from the keyboard", () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    key: "Enter",
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
    ...init,
  });

  it("sends on Enter, never on Shift+Enter, Alt+Enter or while composing", () => {
    expect(submitsOnKey(key({}), "enter")).toBe(true);
    expect(submitsOnKey(key({ metaKey: true }), "enter")).toBe(true);
    expect(submitsOnKey(key({ shiftKey: true }), "enter")).toBe(false);
    expect(submitsOnKey(key({ altKey: true }), "enter")).toBe(false);
    expect(submitsOnKey(key({ isComposing: true }), "enter")).toBe(false);
    expect(submitsOnKey(key({ keyCode: 229 }), "enter")).toBe(false);
    expect(submitsOnKey(key({ key: "a" }), "enter")).toBe(false);
  });

  it("needs Mod+Enter when the shortcut asks for it", () => {
    expect(submitsOnKey(key({}), "mod-enter")).toBe(false);
    expect(submitsOnKey(key({ ctrlKey: true }), "mod-enter")).toBe(true);
    expect(submitsOnKey(key({ metaKey: true }), "mod-enter")).toBe(true);
  });
});

describe("a standalone slash command", () => {
  it("is /plan or /default alone", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
    expect(parseStandaloneComposerSlashCommand("/DEFAULT")).toBe("default");
    expect(parseStandaloneComposerSlashCommand("/plan this")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/model")).toBeNull();
  });
});
