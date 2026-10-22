// A project's scripts follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/project.ts (ProjectScript) and
// packages/shared/src/projectScripts.ts (setupProjectScript, settleProjectScript).
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
});
export type ProjectScript = z.output<typeof ProjectScript>;

/** The setup script of a project: the first that runs on a worktree's creation. */
export const setupProjectScript = (scripts: readonly ProjectScript[]): ProjectScript | undefined =>
  scripts.find((script) => script.runOnWorktreeCreate);

/** The script that runs when a thread settles. */
export const settleProjectScript = (scripts: readonly ProjectScript[]): ProjectScript | undefined =>
  scripts.find((script) => script.runOnSettle === true);
