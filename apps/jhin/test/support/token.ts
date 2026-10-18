import * as Fs from "node:fs";
import * as Path from "node:path";

/** Where the `jhin.auth-token` plugin keeps a node's access token. */
function tokenFile(home: string): string {
  return Path.join(home, "data", "jhin.auth-token", "token");
}

export function readToken(home: string): string {
  return Fs.readFileSync(tokenFile(home), "utf8").trim();
}

/**
 * Gives a home an access token before its first start, so the node never
 * prints the "created the access token" notice. The plugin accepts any token
 * of at least 43 characters.
 */
export function seedToken(home: string): void {
  Fs.mkdirSync(Path.dirname(tokenFile(home)), { recursive: true });
  Fs.writeFileSync(tokenFile(home), `${"t".repeat(43)}\n`, { mode: 0o600 });
}
