import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  discoverSkills,
  parseInitializationCommands,
  parseSkillFrontmatter,
  planSkillDispatch,
} from "../src/commands.ts";

describe("jhin.agent-claude: commands and skills (D300, D301)", () => {
  it("reads Claude Code's commands, one per name, with T3's hint", () => {
    expect(
      parseInitializationCommands([
        { name: "review", description: "", argumentHint: "<pr>" },
        { name: "Review", description: "Review a pull request" },
        { name: " " },
        "nonsense",
      ]),
    ).toEqual([{ name: "review", description: "Review a pull request", input: { hint: "<pr>" } }]);
  });

  it("reads a SKILL.md frontmatter: plain, quoted and block descriptions", () => {
    expect(parseSkillFrontmatter("---\nname: x\ndescription: Deploys: the app\n---\nBody")).toEqual(
      {
        description: "Deploys: the app",
      },
    );
    expect(parseSkillFrontmatter('---\ndescription: "Quoted"\n---\n')).toEqual({
      description: "Quoted",
    });
    expect(
      parseSkillFrontmatter("---\ndescription: >\n  Two\n  lines\nuser-invocable: false\n---\n"),
    ).toEqual({ description: "Two lines", userInvocable: false });
    expect(parseSkillFrontmatter("No frontmatter")).toBeUndefined();
  });

  it("names skills by their folder, the user's before the project's, without the ones the user cannot invoke", async () => {
    const config = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-skills-"));
    const project = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-skills-"));
    const skill = (root: string, name: string, frontmatter: string) => {
      Fs.mkdirSync(Path.join(root, name), { recursive: true });
      Fs.writeFileSync(Path.join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\nDo it.`);
    };
    skill(Path.join(config, "skills"), "deploy", "name: other\ndescription: Mine");
    skill(Path.join(project, ".claude", "skills"), "deploy", "description: Theirs");
    skill(Path.join(project, ".claude", "skills"), "lint", "description: Lint");
    skill(Path.join(project, ".claude", "skills"), "hidden", "user-invocable: false");
    expect(await discoverSkills(config, project)).toEqual([
      {
        name: "deploy",
        description: "Mine",
        path: Path.join(config, "skills", "deploy", "SKILL.md"),
        scope: "user",
      },
      {
        name: "lint",
        description: "Lint",
        path: Path.join(project, ".claude", "skills", "lint", "SKILL.md"),
        scope: "project",
      },
    ]);
  });

  it("dispatches the last $skill as /skill in a block of its own, as T3 does", () => {
    const skills = new Set(["deploy", "lint"]);
    expect(planSkillDispatch("please $lint then $deploy to prod", skills)).toEqual({
      leadingText: "please /lint then",
      commandText: "/deploy to prod",
      skillName: "deploy",
    });
    expect(planSkillDispatch("$deploy", skills)).toEqual({
      commandText: "/deploy",
      skillName: "deploy",
    });
    // Amounts and unknown names stay text.
    expect(planSkillDispatch("costs $5 and $unknown", skills)).toBeUndefined();
  });
});
