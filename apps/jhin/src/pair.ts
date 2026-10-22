// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/cli/pair.ts and
// resolveHeadlessConnectionHost / isLoopbackHost in apps/server/src/startupAccess.ts.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { resolveHome } from "@jhin/node-host";
import { renderTerminalQrCode } from "@jhin/qr-code";

/** What `jhin.http` writes once it listens (docs/plans/security.md D1184). */
export interface RuntimeState {
  readonly url: string;
  readonly pid: number;
  readonly instance: string;
  readonly startedAt: number;
}

/** `auth.pairing.create`'s output (D419). */
export interface PairingLink {
  readonly id: string;
  readonly code: string;
  readonly url?: string;
  readonly label?: string;
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}

export class PairError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const runtimeFile = (home: string | undefined): string =>
  Path.join(resolveHome(home).root, "data", "jhin.http", "runtime.json");

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" ||
  host === "::1" ||
  host === "[::1]" ||
  host.startsWith("127.") ||
  host.endsWith(".localhost");

const isWildcardHost = (host: string): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What answers at an address's `/.well-known/jhin` (docs/plans/security.md D1184). */
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

/**
 * The node running from `home`: its `runtime.json`, when its process is
 * alive and its address answers with the same instance (D1184). A dead node's
 * file, its port maybe reused since, never names another node.
 */
export async function discoverNode(home: string | undefined): Promise<RuntimeState> {
  const file = runtimeFile(home);
  const missing = new PairError(
    "NO_RUNNING_NODE",
    ["No running Jhin node found.", `  checked ${file}`, "Start one with `jhin serve`."].join("\n"),
  );
  let state: RuntimeState;
  try {
    state = JSON.parse(Fs.readFileSync(file, "utf8")) as RuntimeState;
  } catch {
    throw missing;
  }
  // Without an instance to compare, any listener on the address would pass,
  // and the owner token would go to it.
  if (
    typeof state.url !== "string" ||
    typeof state.pid !== "number" ||
    typeof state.instance !== "string" ||
    state.instance === ""
  ) {
    throw missing;
  }
  if (!isProcessAlive(state.pid)) throw missing;
  const probed = await probeNode(localUrl(state.url));
  if (probed.kind !== "node" || probed.instance !== state.instance) throw missing;
  return state;
}

/** The node's address as this machine reaches it: loopback for a wildcard listener. */
export function localUrl(nodeUrl: string): string {
  const url = new URL(nodeUrl);
  if (isWildcardHost(url.hostname) || url.hostname === "") url.hostname = "127.0.0.1";
  return url.origin;
}

/**
 * Where another device reaches a node listening on `url`: a wildcard address
 * becomes this machine's first external address (T3's
 * `resolveHeadlessConnectionHost`), anything else stays.
 */
export function reachableBaseUrl(
  url: string,
  interfaces: NodeJS.Dict<Os.NetworkInterfaceInfo[]> = Os.networkInterfaces(),
): string {
  const parsed = new URL(url);
  if (!isWildcardHost(parsed.hostname)) return parsed.origin;
  const entries = Object.values(interfaces).flatMap((list) => list ?? []);
  const external =
    entries.find((entry) => !entry.internal && entry.family === "IPv4") ??
    entries.find((entry) => !entry.internal && entry.family === "IPv6");
  parsed.hostname = external === undefined ? "localhost" : formatHostForUrl(external.address);
  return parsed.origin;
}

/** T3's notes under a pairing link, for a link only this machine or a plain-HTTP path reaches (D1185). */
export function pairingNotes(pairingUrl: string): string[] {
  const url = new URL(pairingUrl);
  if (isLoopbackHost(url.hostname)) {
    return [
      "This URL is only reachable from this machine. Re-run with --tailscale, or set jhin.http.host to an address other devices reach and restart the node.",
    ];
  }
  if (url.protocol === "http:") {
    return [
      "This URL is plain HTTP: anyone on the network path can read the pairing code and the token it becomes. Prefer --tailscale or an HTTPS proxy.",
    ];
  }
  return [];
}

/** T3's `formatPairOutput`, with Jhin's `Code:` for T3's `Token:`. */
export function formatPairOutput(input: {
  readonly nodeLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly notes: readonly string[];
}): string {
  return [
    `Pairing with ${input.nodeLabel} (${input.origin}).`,
    "",
    renderTerminalQrCode(input.pairingUrl),
    "",
    `Pairing URL: ${input.pairingUrl}`,
    `Code: ${input.code}`,
    `Expires: ${new Date(input.expiresAt).toISOString()}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");
}
