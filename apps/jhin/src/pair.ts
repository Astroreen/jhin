// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/cli/pair.ts and
// resolveHeadlessConnectionHost / isLoopbackHost in apps/server/src/startupAccess.ts.
import * as Os from "node:os";

import { resolveHome } from "@jhin/node-host";
import {
  findRunningNode,
  localUrl,
  probeNode,
  runtimeFile,
  type Probe,
  type RuntimeState,
} from "@jhin/node-host/running";
import { renderTerminalQrCode } from "@jhin/qr-code";
import { holdsPermission, type PermissionEntry } from "@jhin/sdk";

import type { Args } from "./args.ts";

export { localUrl, probeNode, type Probe, type RuntimeState };

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

/**
 * The node running from `home` (D1184), or `NO_RUNNING_NODE` with the file it
 * checked.
 */
export async function discoverNode(home: string | undefined): Promise<RuntimeState> {
  const root = resolveHome(home).root;
  const state = await findRunningNode(root);
  if (state === undefined) {
    throw new PairError(
      "NO_RUNNING_NODE",
      [
        "No running Jhin node found.",
        `  checked ${runtimeFile(root)}`,
        "Start one with `jhin serve`.",
      ].join("\n"),
    );
  }
  return state;
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

/**
 * A note when the code's grants cover a permission with shell access
 * (security.md D1364), as `auth.permissions.list` marks them: one for those
 * without a reason, and one for each with its reason (D1517).
 */
export function shellAccessNotes(
  granted: readonly string[],
  entries: readonly Pick<PermissionEntry, "permission" | "shellAccess" | "shellAccessReason">[],
): string[] {
  const shell = entries.filter(
    (entry) => entry.shellAccess === true && holdsPermission(granted, entry.permission),
  );
  const reasonOf = (entry: (typeof shell)[number]) => entry.shellAccessReason?.trim() || undefined;
  const plain = shell.filter((entry) => reasonOf(entry) === undefined);
  const note = (permissions: string, what: string) =>
    `This link grants shell access (${permissions}): ${what}. Narrow it with --permission.`;
  return [
    ...(plain.length === 0
      ? []
      : [
          note(
            plain.map((entry) => entry.permission).join(", "),
            "the device can run commands on this machine as the node's user",
          ),
        ]),
    ...shell.flatMap((entry) => {
      const reason = reasonOf(entry);
      return reason === undefined ? [] : [note(entry.permission, reason)];
    }),
  ];
}

/** What `jhin pair` says when it could not tell whether a link grants shell access (D1364). */
export function shellAccessUnknown(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PERMISSION_DENIED"
    ? "This token cannot read the node's permissions (auth.read), so it cannot tell whether the link grants shell access (terminals.write). Pass --permission to be sure."
    : `Could not check whether this link grants shell access: ${error instanceof Error ? error.message : String(error)}`;
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

/** T3's default: Tailscale Serve on the tailnet's HTTPS port. */
export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export interface PairFlags {
  readonly permissions: readonly string[];
  readonly ttlMinutes?: number;
  readonly tailscale: boolean;
  readonly servePort: number;
}

/**
 * `jhin pair`'s own flags (D1185, D1189), or why they are refused. A flag
 * without its value is refused, never read as "not given": a bare
 * `--permission` would otherwise pair with every permission the token holds.
 */
export function parsePairFlags(
  args: Pick<Args, "options" | "repeated">,
  hasUrl: boolean,
): PairFlags | { readonly error: string } {
  const { options } = args;
  const option = (key: string) => {
    const value = options.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const given = args.repeated.get("permission") ?? [];
  const permissions = given.every(
    (value): value is string => typeof value === "string" && value !== "",
  )
    ? given
    : undefined;
  const valueless = ["label", "ttl", "base-url", "tailscale-serve-port"].filter(
    (key) => options.get(key) === true,
  );
  if (permissions === undefined) valueless.unshift("permission");
  if (valueless.length > 0) {
    return { error: `${valueless.map((key) => `--${key}`).join(", ")} needs a value` };
  }
  const ttl = option("ttl");
  const ttlMinutes = ttl === undefined ? undefined : Number(ttl);
  if (ttlMinutes !== undefined && !(Number.isFinite(ttlMinutes) && ttlMinutes > 0)) {
    return { error: `--ttl takes minutes, e.g. --ttl 10; got ${ttl}` };
  }
  const tailscale = options.get("tailscale") === true;
  if (options.has("tailscale") && !tailscale) return { error: "--tailscale takes no value" };
  if (options.has("tailscale-serve-port") && !tailscale) {
    return { error: "--tailscale-serve-port needs --tailscale" };
  }
  if (tailscale && (hasUrl || options.has("base-url"))) {
    return {
      error:
        "--tailscale publishes the node running from this home; it takes no --url or --base-url",
    };
  }
  const portText = option("tailscale-serve-port") ?? String(DEFAULT_TAILSCALE_SERVE_PORT);
  // Digits only: `1e3` or `0x1bb` would publish on a port nobody typed.
  const servePort = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
  if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65_535) {
    return { error: `--tailscale-serve-port takes a port; got ${option("tailscale-serve-port")}` };
  }
  return {
    permissions: permissions ?? [],
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    tailscale,
    servePort,
  };
}
