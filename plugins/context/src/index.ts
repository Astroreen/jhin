import { AgentId } from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";

import {
  ContextError,
  createLibrary,
  storyLine,
  type Library,
  type LibrarySettings,
} from "./library.ts";
import { MATURITY_LEVELS, maturityRank } from "./markdown.ts";

export {
  ContextError,
  createLibrary,
  splitAddress,
  type Library,
  type LibrarySettings,
} from "./library.ts";
export { MATURITY_LEVELS, maturityRank, parsePage, slug, type Maturity } from "./markdown.ts";

/** The hook A1 (generations) and A6 (refocus) run to hand an agent its lore (D667). */
export const LORE_BRIEF_HOOK = "lore.brief";

const Level = z.enum(MATURITY_LEVELS);
/** A skill's name is also its directory: no `/`, no `..`. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const Config = z
  .object({
    trailhead: z.string().default("AGENTS.md").meta({
      title: "Trailhead",
      description: "The page every agent starts at, relative to the project.",
    }),
    map: z.string().default("docs/map.md").meta({
      title: "Map",
      description: "The page listing everything the project has, one line each.",
    }),
    library: z.array(z.string()).default(["docs"]).meta({
      title: "Library",
      description: "Directories (or pages) whose Markdown must be reachable from the trailhead.",
    }),
    lore: z
      .string()
      .default("docs/lore")
      .meta({ title: "Lore", description: "The directory of the project's named stories." }),
    maturity: z
      .record(z.string(), Level)
      .default({})
      .meta({
        title: "Maturity by path",
        description:
          "A page (`AGENTS.md`) or a directory (`docs/lore/`, the `/` optional) → level, for pages without `maturity` in their front matter. The longest match wins.",
        examples: [{ "docs/lore/": "insight", "AGENTS.md": "canon" }],
      }),
    skill: z
      .object({
        name: z
          .string()
          .regex(SKILL_NAME, "a skill name is lowercase letters, digits and dashes")
          .optional()
          .meta({ title: "Name", description: "Default: `<project directory>-map`." }),
        description: z
          .string()
          .optional()
          .meta({ title: "Description", description: "What makes an agent open the skill." }),
        route: z.string().default("find-your-way").meta({
          title: "Route section",
          description: "The trailhead's section the skill starts with.",
        }),
        dirs: z
          .array(z.string())
          .default([".claude/skills"])
          .meta({ title: "Install into", description: "Where runtimes look for project skills." }),
      })
      .default({ route: "find-your-way", dirs: [".claude/skills"] })
      .meta({ title: "Router skill" }),
  })
  .meta({
    title: "Context library",
    description:
      "How the project's Markdown is arranged: trailhead, map, library, lore and maturity.",
  });
type Config = z.output<typeof Config>;

const Project = z
  .string()
  .optional()
  .describe("A project of this node (`projects.list`); default: the directory the node runs in.");
const Agent = AgentId.optional().describe(
  "Also the lore of this agent (`.jhin/agents/<id>/lore/`).",
);

const Section = z.object({
  address: z.string(),
  path: z.string(),
  heading: z.string().optional(),
  anchor: z.string().optional(),
  maturity: Level.optional(),
  /** 0 unmarked … 4 canon; on conflicts the higher rank wins. */
  rank: z.number(),
  content: z.string(),
});

const Story = z.object({
  name: z.string(),
  title: z.string(),
  lesson: z.string().optional(),
  address: z.string(),
  scope: z.enum(["project", "agent"]),
});

const Brief = z.object({
  projectId: Project,
  agent: Agent,
  reason: z.enum(["start", "compaction", "request"]).default("request"),
  full: z.boolean().default(false).describe("The whole stories, not only their names and lessons."),
});

const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

const toSection = (section: ReturnType<Library["read"]>) =>
  defined({ ...section, rank: maturityRank(section.maturity) }) as z.input<typeof Section>;

const withoutContent = <T extends { content: unknown }>(section: T): Omit<T, "content"> => {
  const rest: Partial<T> = { ...section };
  delete rest.content;
  return rest as Omit<T, "content">;
};

export default definePlugin({
  activate(context) {
    context.config.define("jhin.context", Config);

    // One library per project root, keeping parsed pages until their files
    // change; a config change replaces it.
    const libraries = new Map<string, { config: string; library: Library }>();
    context.subscriptions.add(toDisposable(() => libraries.clear()));

    const paths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
    // host.paths@1.1 is required: a node host names the directory it runs in.
    const cwd = (): string => {
      if (paths.cwd === undefined) {
        throw new ContextError("PROJECT_NOT_FOUND", "The host names no project directory", {});
      }
      return paths.cwd;
    };
    const rootOf = async (projectId: string | undefined): Promise<string> => {
      if (projectId === undefined) return cwd();
      // Projects are the `projects.*` commands of whichever plugin keeps them
      // (jhin.threads), reached like any other command, as jhin.source-control does.
      let projects: { id: string; path: string }[];
      try {
        projects = (await context.commands.execute("projects.list", {})) as typeof projects;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "COMMAND_NOT_FOUND") throw error;
        throw new ContextError(
          "PROJECT_NOT_FOUND",
          `No project ${projectId}: this node keeps no projects (no projects.list)`,
          { projectId },
        );
      }
      // A root the node no longer has (a removed project) drops its library.
      const known = new Set([
        ...(paths.cwd === undefined ? [] : [paths.cwd]),
        ...projects.map((entry) => entry.path),
      ]);
      for (const root of libraries.keys()) if (!known.has(root)) libraries.delete(root);
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) {
        throw new ContextError("PROJECT_NOT_FOUND", `No project ${projectId} on this node`, {
          projectId,
        });
      }
      return project.path;
    };

    const libraryOf = async (projectId: string | undefined): Promise<Library> => {
      const root = await rootOf(projectId);
      const settings = context.config.get<Config>("jhin.context");
      const config = JSON.stringify(settings);
      const known = libraries.get(root);
      if (known !== undefined && known.config === config) return known.library;
      const library = createLibrary(root, settings as LibrarySettings);
      libraries.set(root, { config, library });
      return library;
    };

    const reading = { permissions: ["context.read"] };

    context.commands.register({
      name: "context.read",
      description:
        "One section of a Markdown page of the project, by address (`docs/plans/terminal.md#deferred`, `docs/plans/foundation.md#D11`), with its maturity",
      input: z.object({
        path: z.string().min(1).describe("Project-relative path, optionally with `#heading`."),
        heading: z
          .string()
          .optional()
          .describe("Heading anchor or text, or a decision id (`D11`)."),
        projectId: Project,
      }),
      output: Section.extend({
        headings: z.array(z.object({ depth: z.number(), text: z.string(), anchor: z.string() })),
      }),
      ...reading,
      handler: async ({ path, heading, projectId }) => {
        const library = await libraryOf(projectId);
        const section = library.read(path, heading);
        return { ...toSection(section), headings: library.headings(section.path) };
      },
    });

    context.commands.register({
      name: "context.view",
      description:
        "Composes sections of several pages into one Markdown view, each marked with its address and maturity",
      input: z.object({
        sections: z
          .array(z.string().min(1))
          .min(1)
          .describe("Addresses, in the order to show them."),
        title: z.string().optional(),
        projectId: Project,
      }),
      output: z.object({
        markdown: z.string(),
        sections: z.array(Section.omit({ content: true })),
      }),
      ...reading,
      handler: async ({ sections, title, projectId }) => {
        const library = await libraryOf(projectId);
        const parts = sections.map((address) => toSection(library.read(address)));
        const markdown = [
          ...(title === undefined ? [] : [`# ${title}`, ""]),
          ...parts.flatMap((section) => [
            `<!-- ${section.address}${section.maturity === undefined ? "" : ` (${section.maturity})`} -->`,
            section.content.trim(),
            "",
          ]),
        ]
          .join("\n")
          .trimEnd();
        return { markdown: `${markdown}\n`, sections: parts.map(withoutContent) };
      },
    });

    context.commands.register({
      name: "context.map",
      description:
        "The project's map, and which pages no route from the trailhead reaches, and which routes are broken",
      input: z.object({
        projectId: Project,
        content: z.boolean().default(false).describe("Include the map's Markdown."),
      }),
      output: z.object({
        map: z.string(),
        content: z.string().optional(),
        trailhead: z.string(),
        reached: z.array(
          z.object({ path: z.string(), depth: z.number(), via: z.string().optional() }),
        ),
        unreachable: z.array(z.string()),
        broken: z.array(
          z.object({
            from: z.string(),
            line: z.number(),
            kind: z.enum(["link", "mention"]),
            target: z.string(),
            reason: z.enum(["missing", "anchor"]),
          }),
        ),
        unresolved: z.array(
          z.object({
            from: z.string(),
            line: z.number(),
            kind: z.enum(["link", "mention"]),
            target: z.string(),
          }),
        ),
      }),
      ...reading,
      handler: async ({ projectId, content }) => {
        const library = await libraryOf(projectId);
        const config = context.config.get<Config>("jhin.context");
        const report = library.reach();
        return {
          map: config.map,
          ...(content ? { content: library.read(config.map).content } : {}),
          trailhead: report.trailhead,
          reached: report.reached.map((entry) => defined(entry) as { path: string; depth: number }),
          unreachable: [...report.unreachable],
          broken: [...report.broken],
          unresolved: [...report.unresolved],
        };
      },
    });

    const Skill = z.object({ name: z.string(), description: z.string(), content: z.string() });

    context.commands.register({
      name: "context.skill",
      description:
        "The project's router skill, generated from its trailhead and map, without writing it (`context.skill.install` writes it)",
      input: z.object({ projectId: Project }),
      output: Skill,
      ...reading,
      handler: async ({ projectId }) => (await libraryOf(projectId)).skill(),
    });

    context.commands.register({
      name: "context.skill.install",
      description:
        "Generates the project's router skill and writes it where runtimes look for skills",
      input: z.object({ projectId: Project }),
      output: Skill.extend({ installed: z.array(z.string()) }),
      permissions: ["context.write"],
      handler: async ({ projectId }) => {
        const library = await libraryOf(projectId);
        const generated = library.skill();
        return { ...generated, installed: library.install(generated) };
      },
    });

    context.commands.register({
      name: "lore.list",
      description: "The project's named stories (and an agent's), each with its one-line lesson",
      input: z.object({ projectId: Project, agent: Agent }),
      output: z.array(Story),
      ...reading,
      handler: async ({ projectId, agent }) =>
        (await libraryOf(projectId))
          .stories(agent)
          .map((story) => defined({ ...story }) as z.input<typeof Story>),
    });

    context.commands.register({
      name: "lore.get",
      description: 'One story of the lore by its name ("moonbase"), title or path',
      input: z.object({ name: z.string().min(1), projectId: Project, agent: Agent }),
      output: Story.extend({ content: z.string(), maturity: Level.optional() }),
      ...reading,
      handler: async ({ name, projectId, agent }) =>
        defined({ ...(await libraryOf(projectId)).story(name, agent) }) as z.input<typeof Story> & {
          content: string;
        },
    });

    context.commands.register({
      name: "lore.brief",
      description:
        "The lore to hand an agent on start or after a compaction, as Markdown; other plugins change it through the `lore.brief` hook",
      input: Brief,
      output: z.object({ markdown: z.string(), stories: z.array(z.string()) }),
      ...reading,
      handler: (input) =>
        context.hooks.run(LORE_BRIEF_HOOK, input, async ({ projectId, agent, reason, full }) => {
          const library = await libraryOf(projectId);
          const stories = library.stories(agent);
          const lines = [
            "# Lore",
            "",
            reason === "compaction"
              ? "Your context was compacted. Before you go on, recall these stories; in review a name is enough."
              : "Stories of how agents go wrong here. In review a name is enough: it means the whole story.",
            "",
            ...stories.map(storyLine),
            ...(full
              ? stories.flatMap((story) => [
                  "",
                  "---",
                  "",
                  library.read(story.address).content.trim(),
                ])
              : []),
          ];
          return { markdown: `${lines.join("\n")}\n`, stories: stories.map((story) => story.name) };
        }),
    });
  },
});
