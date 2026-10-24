// Finding the node that runs from a home (docs/plans/security.md D1184): what
// `jhin pair` and the desktop app (docs/plans/desktop.md D1486) look for before
// they talk to one. Node built-ins only, so the desktop app bundles it alone.
import * as Fs from "node:fs";
import * as Path from "node:path";

/** What `jhin.http` writes once it listens (D1184). */
export interface RuntimeState {
  readonly url: string;
  readonly pid: number;
  readonly instance: string;
  readonly startedAt: number;
}

/** Where a node of `homeRoot` says it listens. */
export const runtimeFile = (homeRoot: string): string =>
  Path.join(homeRoot, "data", "jhin.http", "runtime.json");

const isWildcardHost = (host: string): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What answers at an address's `/.well-known/jhin` (D1184). */
export type Probe =
  | { readonly kind: "node"; readonly instance: string }
  | { readonly kind: "unreachable" }
  | { readonly kind: "other" };

export async function probeNode(baseUrl: string): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(new URL("/.well-known/jhin", baseUrl), {
      signal: AbortSignal.timeout(2_500),
    });
  } catch {
    return { kind: "unreachable" };
  }
  // A proxy answering for a backend that is gone (a stale mapping) is no
  // occupant: T3 treats the bad-gateway family as unreachable, so the mapping
  // can be repaired after the node's port changed.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return { kind: "unreachable" };
  }
  try {
    const body = (await response.json()) as { instance?: unknown };
    return response.ok && typeof body.instance === "string"
      ? { kind: "node", instance: body.instance }
      : { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

/** The node's address as this machine reaches it: loopback for a wildcard listener. */
export function localUrl(nodeUrl: string): string {
  const url = new URL(nodeUrl);
  if (isWildcardHost(url.hostname) || url.hostname === "") url.hostname = "127.0.0.1";
  return url.origin;
}

/**
 * The node running from `homeRoot`: its `runtime.json`, when its process is
 * alive and its address answers with the same instance (D1184). A dead node's
 * file, its port maybe reused since, never names another node.
 */
export async function findRunningNode(homeRoot: string): Promise<RuntimeState | undefined> {
  let state: RuntimeState;
  try {
    state = JSON.parse(Fs.readFileSync(runtimeFile(homeRoot), "utf8")) as RuntimeState;
  } catch {
    return undefined;
  }
  // Without an instance to compare, any listener on the address would pass,
  // and the owner token would go to it.
  if (
    typeof state.url !== "string" ||
    typeof state.pid !== "number" ||
    typeof state.instance !== "string" ||
    state.instance === ""
  ) {
    return undefined;
  }
  if (!isProcessAlive(state.pid)) return undefined;
  const probed = await probeNode(localUrl(state.url));
  return probed.kind === "node" && probed.instance === state.instance ? state : undefined;
}
