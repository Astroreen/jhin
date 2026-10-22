// Where Claude Code keeps a session, as T3 Code finds it
// (https://github.com/pingdotgg/t3code, ClaudeAdapterV2.ts hasEmptyClaudeTranscript at
// eb7b35ac): `<config dir>/projects/<project>/<session id>.jsonl`, and the session's
// subagent transcripts in `<session id>/` beside it.
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { inheritedEnvironment } from "./session.ts";

/** Session ids are UUIDs: nothing else is looked for, so no id leaves the projects folder. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code's config directory: the config's `CLAUDE_CONFIG_DIR`, the node's when the
 * allow-list passes it to Claude Code (D346), else `~/.claude`.
 */
export function claudeConfigDir(
  env: Readonly<Record<string, string>> = {},
  inherit?: readonly string[],
): string {
  const configured = (
    env["CLAUDE_CONFIG_DIR"] ??
    inheritedEnvironment(inherit)["CLAUDE_CONFIG_DIR"] ??
    ""
  ).trim();
  return configured.length > 0 ? Path.resolve(configured) : Path.join(Os.homedir(), ".claude");
}

/**
 * Removes a session's files from every project folder (D345); how many were removed.
 * A missing folder or file is nothing to remove.
 */
export async function deleteSessionFiles(sessionId: string, configDir: string): Promise<number> {
  if (!SESSION_ID.test(sessionId)) return 0;
  const projects = Path.join(configDir, "projects");
  let entries: string[];
  try {
    entries = await Fs.readdir(projects);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const project of entries) {
    for (const name of [`${sessionId}.jsonl`, sessionId]) {
      const target = Path.join(projects, project, name);
      try {
        await Fs.lstat(target);
      } catch {
        continue;
      }
      await Fs.rm(target, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
