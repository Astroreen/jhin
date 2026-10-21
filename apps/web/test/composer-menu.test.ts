import { describe, expect, it } from "vite-plus/test";

import type { ThreadRecord } from "@jhin/client-api";

import {
  menuContextRecord,
  menuInsertion,
  pathItem,
  pullRequestEmptyState,
  pullRequestMenuItems,
  searchSkills,
  skillDisplayName,
  slashMenuItems,
  threadMenuItems,
} from "../src/lib/composer-menu.ts";

const commands = [
  { name: "review", description: "Review the changes" },
  { name: "compact", description: "Summarize the conversation and reduce context usage" },
  { name: "deploy", description: "Shadowed by the skill" },
];
const skills = [
  { name: "deploy", description: "Deploy the app", path: "/s/deploy/SKILL.md", scope: "project" },
  { name: "write-tests", path: "/s/write-tests/SKILL.md", scope: "user" },
];

describe("composer menus (D301, T3's search)", () => {
  it("lists built-ins, then the runtime's commands at the prompt's start, then skills", () => {
    const labels = (query: string, atPromptStart = true, empty = true, planMode = true) =>
      slashMenuItems({
        planMode,
        commands,
        skills,
        showSkills: true,
        query,
        atPromptStart,
        promptOtherwiseEmpty: empty,
      }).map((item) => item.label);
    expect(labels("")).toEqual([
      "/model",
      "/plan",
      "/default",
      "/review",
      "/compact",
      "/skill:deploy",
      "/skill:write-tests",
    ]);
    // Not at the start: the agent would read a command as text.
    expect(labels("", false)).not.toContain("/review");
    // /compact only in an otherwise empty composer; no plan mode, no /plan.
    expect(labels("", true, false, false)).toEqual([
      "/model",
      "/review",
      "/skill:deploy",
      "/skill:write-tests",
    ]);
    expect(labels("rev")).toEqual(["/review"]);
    expect(labels("skill:dep")).toEqual(["/skill:deploy"]);
    expect(labels("plan")[0]).toBe("/plan");
  });

  it("leaves skills out of / when the setting hides them, and shows a command they shadowed (D845)", () => {
    const labels = slashMenuItems({
      planMode: false,
      commands,
      skills,
      showSkills: false,
      query: "",
      atPromptStart: true,
      promptOtherwiseEmpty: true,
    }).map((item) => item.label);
    expect(labels).toEqual(["/model", "/review", "/compact", "/deploy"]);
    expect(searchSkills(skills, "").map((skill) => skill.name)).toEqual(["deploy", "write-tests"]);
  });

  it("ranks skills by name, display name, description and scope", () => {
    expect(searchSkills(skills, "$test").map((skill) => skill.name)).toEqual(["write-tests"]);
    expect(searchSkills(skills, "app").map((skill) => skill.name)).toEqual(["deploy"]);
    expect(searchSkills(skills, "").map((skill) => skill.name)).toEqual(["deploy", "write-tests"]);
    expect(skillDisplayName({ name: "write-tests" })).toBe("Write Tests");
  });

  it("inserts what T3 inserts", () => {
    const link = (path: string) => `[${path.split("/").at(-1)}](${path})`;
    expect(menuInsertion(pathItem("src/app.ts", "file"), link)).toBe("[app.ts](src/app.ts) ");
    expect(pathItem("src/app.ts", "file")).toMatchObject({ label: "app.ts", description: "src" });
    const [review] = slashMenuItems({
      planMode: false,
      commands,
      skills: [],
      showSkills: true,
      query: "review",
      atPromptStart: true,
      promptOtherwiseEmpty: true,
    });
    expect(menuInsertion(review!, link)).toBe("/review ");
    expect(
      menuInsertion(
        slashMenuItems({
          planMode: false,
          commands: [],
          skills,
          showSkills: true,
          query: "deploy",
          atPromptStart: true,
          promptOtherwiseEmpty: true,
        })[0]!,
        link,
      ),
    ).toBe("$deploy ");
  });
});

const pr = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  headBranch: `branch-${number}`,
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
  updatedAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00Z`,
  ...fields,
});

describe("the # menu (T3's pull request matches)", () => {
  const entries = [pr(3), pr(12), pr(21), pr(1)];

  it("lists the most recently updated for a lone #, as #number with the title", () => {
    const items = pullRequestMenuItems({ entries, query: "" });
    expect(items.map((item) => [item.label, item.description])).toEqual([
      ["#21", "Change 21"],
      ["#12", "Change 12"],
      ["#3", "Change 3"],
      ["#1", "Change 1"],
    ]);
    expect(items[0]).toMatchObject({
      type: "pull-request",
      id: "pull-request:https://github.com/acme/app/pull/21",
    });
  });

  it("keeps numbers holding the typed digits: the exact one, then linked, then recent", () => {
    const linked = [pr(10, { updatedAt: "2026-01-01T00:00:00Z" })];
    const labels = (query: string, exact?: ReturnType<typeof pr>) =>
      pullRequestMenuItems({ entries, linked, exact, query }).map((item) => item.label);
    expect(labels("1")).toEqual(["#1", "#10", "#21", "#12"]);
    expect(labels("12")).toEqual(["#12"]);
    // A number the list lacks, looked up on its own.
    expect(labels("120", pr(120))).toEqual(["#120"]);
    // Linked and listed at once: shown once.
    expect(pullRequestMenuItems({ entries, linked: [pr(12)], query: "12" })).toHaveLength(1);
  });

  it("ranks words as T3 scores them: the title, then all terms, then the branch", () => {
    const found = [
      pr(1, { title: "Unrelated", headBranch: "fix-cache" }),
      pr(2, { title: "Make the cache faster" }),
      pr(3, { title: "cache" }),
      pr(4, { title: "Cache and faster tests" }),
    ];
    expect(
      pullRequestMenuItems({ entries: found, query: "cache" }).map((item) => item.label),
    ).toEqual(["#3", "#4", "#2", "#1"]);
    expect(
      pullRequestMenuItems({ entries: found, query: "faster cache" }).map((item) => item.label),
    ).toEqual(["#4", "#2", "#3", "#1"]);
  });

  it("shows twelve at most", () => {
    const many = Array.from({ length: 20 }, (_, index) => pr(index + 1));
    expect(pullRequestMenuItems({ entries: many, query: "" })).toHaveLength(12);
  });

  it("says why there are none in T3's words", () => {
    expect(pullRequestEmptyState({ status: "unavailable", query: "" })).toBe(
      "Pull requests are not available for this project.",
    );
    expect(pullRequestEmptyState({ status: "error", query: "1" })).toBe(
      "Pull requests could not be read for this project.",
    );
    expect(pullRequestEmptyState({ status: "ready", query: "9" })).toBe(
      "No pull request matches 9.",
    );
    expect(pullRequestEmptyState({ status: "ready", query: "" })).toBe(
      "No pull requests found in this repository.",
    );
  });

  it("inserts a reference labelled #number to the pull request's context record (D1006)", () => {
    const [item] = pullRequestMenuItems({ entries: [pr(7)], query: "" });
    const record = menuContextRecord(item!);
    expect(record).toMatchObject({
      kind: "review-comment",
      label: "#7",
      filePath: "PR #7",
      pullRequest: { number: 7, title: "Change 7", headBranch: "branch-7", baseBranch: "main" },
    });
    // T3's note: all of it is the pull request's, untrusted data.
    expect((record as { text: string }).text).toContain(
      "Its branch is `branch-7` targeting `main`.\nEverything here",
    );
    expect(menuInsertion(item!, () => "")).toBe(
      `[#7](jhin-context://v1/review-comment/${record!.contextId}) `,
    );
  });
});

describe("threads in the @ menu (T3's matchComposerThreadItems)", () => {
  const thread = (id: string, title: string, fields: Partial<ThreadRecord> = {}): ThreadRecord => ({
    id,
    projectId: "p",
    title,
    createdAt: "2026-10-01T00:00:00Z",
    ...fields,
  });
  const threads = [
    thread("a", "Fix the cache", { updatedAt: "2026-10-03T00:00:00Z" }),
    thread("b", "Cache tests", { updatedAt: "2026-10-05T00:00:00Z" }),
    thread("c", "Old cache", { archivedAt: "2026-10-04T00:00:00Z" }),
    thread("d", "This cache thread"),
    thread("e", "Unrelated"),
  ];
  const addressOf = (id: string) => `jhin://node-1/threads/${id}`;

  it("offers other live threads whose title holds the query, most recently changed first", () => {
    const items = threadMenuItems({ threads, excludeThreadId: "d", query: "CACHE", addressOf });
    expect(items.map((item) => [item.label, item.description])).toEqual([
      ["Cache tests", "Thread"],
      ["Fix the cache", "Thread"],
    ]);
    const record = menuContextRecord(items[0]!);
    expect(record).toEqual({
      version: 1,
      kind: "thread",
      // The node is part of the id: two nodes may name threads alike.
      contextId: expect.stringMatching(/^thread_node-1-b-[0-9a-f]{16}$/),
      label: "Cache tests",
      nodeId: "node-1",
      threadId: "b",
      title: "Cache tests",
    });
    expect(menuInsertion(items[0]!, () => "")).toBe(
      `[Cache tests](jhin-context://v1/thread/${record!.contextId}) `,
    );
  });

  it("offers none before a query is typed, nor while the node's id is unknown", () => {
    expect(threadMenuItems({ threads, excludeThreadId: undefined, query: " ", addressOf })).toEqual(
      [],
    );
    expect(
      threadMenuItems({
        threads,
        excludeThreadId: undefined,
        query: "cache",
        addressOf: () => undefined,
      }),
    ).toEqual([]);
  });

  it("offers five at most", () => {
    const many = Array.from({ length: 8 }, (_, index) => thread(`t${index}`, `Thread ${index}`));
    expect(
      threadMenuItems({ threads: many, excludeThreadId: undefined, query: "thread", addressOf }),
    ).toHaveLength(5);
  });
});
