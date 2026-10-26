// A project's scripts follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/project.ts (ProjectScript), packages/contracts/src/keybindings.ts
// (MAX_SCRIPT_ID_LENGTH, SCRIPT_RUN_COMMAND_PATTERN), packages/shared/src/projectScripts.ts
// (setupProjectScript, settleProjectScript, projectScriptMenuLabel) and apps/web/src/projectScripts.ts
// (nextProjectScriptId, primaryProjectScript, commandForProjectScript, releaseClaimedRoles).
import { z } from "@jhin/sdk";

/** The icon of a project script in T3's scripts menu. */
export const ProjectScriptIcon = z.enum(["play", "test", "lint", "configure", "build", "debug"]);
export type ProjectScriptIcon = z.infer<typeof ProjectScriptIcon>;

/** A project's script (D1121): a shell command run in a terminal of a thread. */
export const ProjectScript = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  command: z.string().trim().min(1),
  icon: ProjectScriptIcon.default("play"),
  /** Runs in a new worktree of a thread, once it is made (the setup script, D1122). */
  runOnWorktreeCreate: z.boolean().default(false),
  /** Runs in a thread's worktree each time the thread settles. */
  runOnSettle: z.boolean().optional(),
  /**
   * Only for a setup script: true (the default) lets the agent start while it
   * still runs; false holds the agent until it exits.
   */
  async: z.boolean().optional(),
  /** Opened in the in-app browser preview when this script runs (D1471). */
  previewUrl: z.string().trim().min(1).optional(),
  /** Opens the preview at `previewUrl` the moment the script starts. */
  autoOpenPreview: z.boolean().optional(),
});
export type ProjectScript = z.output<typeof ProjectScript>;

/** The setup script of a project: the first that runs on a worktree's creation. */
export const setupProjectScript = (scripts: readonly ProjectScript[]): ProjectScript | undefined =>
  scripts.find((script) => script.runOnWorktreeCreate);

/** The script that runs when a thread settles. */
export const settleProjectScript = (scripts: readonly ProjectScript[]): ProjectScript | undefined =>
  scripts.find((script) => script.runOnSettle === true);

/** A script's name in the scripts menu, with the roles it has: `Install (setup, on settle)`. */
export function projectScriptMenuLabel(script: ProjectScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle === true ? ["on settle"] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

/** The script the header's button runs: the first without a role, else the first not run on settle. */
export function primaryProjectScript(scripts: readonly ProjectScript[]): ProjectScript | undefined {
  return (
    scripts.find((script) => !script.runOnWorktreeCreate && script.runOnSettle !== true) ??
    scripts.find((script) => script.runOnSettle !== true)
  );
}

/** How long a script id may be, so its `script.<id>.run` command is one T3 takes too. */
export const MAX_SCRIPT_ID_LENGTH = 24;
const SCRIPT_ID = /^[a-z0-9][a-z0-9-]*$/;

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

/** A new script's id from its name, unique among `existingIds`. */
export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    const safe =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safe)) return safe;
  }
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

/** The client command that runs a script by its id (T3's `script.<id>.run`, D1475), if it can have one. */
export function commandForProjectScript(scriptId: string): string | undefined {
  return scriptId.length <= MAX_SCRIPT_ID_LENGTH && SCRIPT_ID.test(scriptId)
    ? `script.${scriptId}.run`
    : undefined;
}

/**
 * A script that loses its setup or settle role to `saved`: a project has one
 * setup script and one settle script.
 */
export function releaseClaimedRoles(
  script: ProjectScript,
  saved: Pick<ProjectScript, "runOnWorktreeCreate" | "runOnSettle">,
): ProjectScript {
  const releaseSetup = saved.runOnWorktreeCreate && script.runOnWorktreeCreate;
  const releaseSettle = saved.runOnSettle === true && script.runOnSettle === true;
  if (!releaseSetup && !releaseSettle) return script;
  return {
    ...script,
    ...(releaseSetup ? { runOnWorktreeCreate: false } : {}),
    ...(releaseSettle ? { runOnSettle: false } : {}),
  };
}
