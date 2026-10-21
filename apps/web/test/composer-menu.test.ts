import { describe, expect, it } from "vite-plus/test";

import {
  menuInsertion,
  pathItem,
  searchSkills,
  skillDisplayName,
  slashMenuItems,
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
