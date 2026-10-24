// The checked-in project file follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/t3ProjectFile.ts (T3ProjectFile) and
// packages/shared/src/t3ProjectFile.ts with schemaJson.ts (parseT3ProjectFile, lenient JSON).
import { z } from "@jhin/sdk";

import { ProjectScriptIcon } from "./project-scripts.ts";

/** The file's name at a project's root, T3's, so a repository set up for T3 works unchanged (D1465). */
export const T3_PROJECT_FILE_NAME = "t3.json";
export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const trimmedNonEmpty = (description: string, maxLength?: number) =>
  (maxLength === undefined
    ? z.string().trim().min(1)
    : z.string().trim().min(1).max(maxLength)
  ).meta({ description });

/** How new worktrees populate git submodules (T3's `WorktreeSubmodules`). */
export const WorktreeSubmodules = z.enum(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = z.infer<typeof WorktreeSubmodules>;

export const T3ProjectFileScript = z
  .object({
    name: trimmedNonEmpty("Display name for the script, shown in the T3 Code scripts menu."),
    command: trimmedNonEmpty("Shell command executed in a T3 Code terminal at the project root."),
    icon: ProjectScriptIcon.optional().meta({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
    runOnWorktreeCreate: z.boolean().optional().meta({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
    runOnSettle: z.boolean().optional().meta({
      description:
        "When true, the script runs in the thread's worktree each time the thread settles, for example to delete build output. Threads without their own worktree skip it.",
    }),
    async: z.boolean().optional().meta({
      description:
        "Only for runOnWorktreeCreate scripts. When true (the default), the agent starts while the script is still running. Set false to hold the agent until the script exits.",
    }),
    previewUrl: trimmedNonEmpty(
      "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    ).optional(),
    autoOpenPreview: z.boolean().optional().meta({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  })
  .meta({ description: "A project script that team members can import into T3 Code." });
export type T3ProjectFileScript = z.output<typeof T3ProjectFileScript>;

/** T3's `t3.json`: scripts and defaults checked in with a repository (D1465). */
export const T3ProjectFile = z
  .object({
    $schema: z
      .string()
      .optional()
      .meta({
        description: `URL of the JSON Schema for this file, typically "${T3_PROJECT_FILE_SCHEMA_URL}".`,
      }),
    iconPath: trimmedNonEmpty(
      'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      512,
    ).optional(),
    defaultThreadEnvMode: z.enum(["local", "worktree"]).optional().meta({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in T3 Code overrides this; when neither is set, the global default applies.',
    }),
    worktreeSubmodules: WorktreeSubmodules.optional().meta({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup script to handle. A project or environment setting in T3 Code overrides this.',
    }),
    scripts: z.array(T3ProjectFileScript).max(50).optional().meta({
      description: "Project scripts shared with everyone who opens this repository in T3 Code.",
    }),
  })
  .meta({
    title: "T3 project file",
    description:
      "Checked-in project configuration for T3 Code (t3.json at the repository root). See https://t3.codes for documentation.",
  });
export type T3ProjectFile = z.output<typeof T3ProjectFile>;

/** Outside a string: a line comment, a block comment, or a comma before a closing bracket. */
const OUTSIDE_STRINGS = [
  /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
  /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
] as const;
const TRAILING_COMMA = /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g;

/** T3's lenient JSON: comments and trailing commas are dropped first. */
function parseLenientJson(text: string): unknown {
  let stripped = text;
  for (const pattern of OUTSIDE_STRINGS) {
    stripped = stripped.replace(pattern, (match, literal: string | undefined) =>
      literal === undefined ? "" : match,
    );
  }
  stripped = stripped.replace(
    TRAILING_COMMA,
    (match, literal: string | undefined, bracket: string | undefined) =>
      literal === undefined ? (bracket ?? "") : match,
  );
  return JSON.parse(stripped);
}

/** A `t3.json`'s contents read: the file, or why it is none (T3 logs it and reads none). */
export type T3ProjectFileRead =
  | { readonly file: T3ProjectFile; readonly error?: undefined }
  | { readonly file: null; readonly error: string };

export function parseT3ProjectFile(contents: string): T3ProjectFileRead {
  let raw: unknown;
  try {
    raw = parseLenientJson(contents);
  } catch (error) {
    return {
      file: null,
      error: `${T3_PROJECT_FILE_NAME} is not JSON: ${(error as Error).message}`,
    };
  }
  const parsed = T3ProjectFile.safeParse(raw);
  if (parsed.success) return { file: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  return {
    file: null,
    error: `${T3_PROJECT_FILE_NAME} is not a T3 project file${where}: ${issue?.message ?? "invalid"}`,
  };
}
