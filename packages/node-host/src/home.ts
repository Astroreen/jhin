import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

/** Where a node keeps its config, plugins, logs and identity. */
export interface JhinHome {
  readonly root: string;
  readonly plugins: string;
  readonly logs: string;
  readonly config: string;
}

export function resolveHome(
  root = process.env["JHIN_HOME"] ?? Path.join(Os.homedir(), ".jhin"),
): JhinHome {
  const home = {
    root,
    plugins: Path.join(root, "plugins"),
    logs: Path.join(root, "logs"),
    config: Path.join(root, "config.jsonc"),
  };
  Fs.mkdirSync(home.plugins, { recursive: true });
  Fs.mkdirSync(home.logs, { recursive: true });
  return home;
}

/**
 * The node's stable id, created on first start (D23). Key pairs and mesh
 * identity build on this file in the mesh PR.
 */
export function readNodeId(home: JhinHome): string {
  const file = Path.join(home.root, "node-id");
  try {
    const existing = Fs.readFileSync(file, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = Crypto.randomUUID();
  Fs.writeFileSync(file, `${id}\n`, { flag: "wx" });
  return id;
}
