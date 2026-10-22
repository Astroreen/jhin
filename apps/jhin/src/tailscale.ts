// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/tailscale/src/tailscale.ts and
// resolveTailscalePairingBase / resolveTailscaleLocalTarget in apps/server/src/cli/pair.ts.
import * as ChildProcess from "node:child_process";

import { PairError, localUrl, probeNode, type Probe, type RuntimeState } from "./pair.ts";

/** T3's default: Tailscale Serve on the tailnet's HTTPS port. */
export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const SERVE_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 1_500;
/** Tailscale provisions a certificate on a fresh mapping's first request, which takes a few seconds. */
const PROBE_ATTEMPTS = 5;

/** Runs `tailscale <args>`; rejects only when it cannot be started. */
export type TailscaleRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ readonly code: number; readonly stdout: string }>;

export const runTailscale: TailscaleRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    ChildProcess.execFile(
      process.platform === "win32" ? "tailscale.exe" : "tailscale",
      [...args],
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => {
        if (error !== null && typeof error.code !== "number") reject(error);
        else resolve({ code: error === null ? 0 : (error.code as number), stdout });
      },
    );
  });

/** `Self.DNSName` of `tailscale status --json`, without its trailing dot. */
export function parseMagicDnsName(statusJson: string): string | undefined {
  try {
    const status = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
    const name = status.Self?.DNSName;
    const normalized = typeof name === "string" ? name.trim().replace(/\.$/u, "") : "";
    return normalized === "" ? undefined : normalized;
  } catch {
    return undefined;
  }
}

/** T3's `buildTailscaleHttpsBaseUrl`, as an origin: the port only when it is not 443. */
export function tailscaleBaseUrl(magicDnsName: string, servePort: number): string {
  const url = new URL(`https://${magicDnsName}`);
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) url.port = String(servePort);
  return url.origin;
}

/**
 * Publishes the node over Tailscale Serve HTTPS and returns the tailnet
 * address to pair through, with T3's notes (D1189). A mapping that already
 * fronts this node is kept; one that answers as something else is never
 * replaced.
 */
export async function publishOverTailscale(input: {
  readonly node: RuntimeState;
  readonly servePort: number;
  readonly run?: TailscaleRunner;
  readonly probe?: (baseUrl: string) => Promise<Probe>;
  /** Between probes of a fresh mapping; a second by default. */
  readonly pause?: () => Promise<void>;
}): Promise<{ baseUrl: string; notes: string[] }> {
  const run = input.run ?? runTailscale;
  const probe = input.probe ?? probeNode;
  const pause = input.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
  const notes: string[] = [];
  const unavailable = new PairError(
    "TAILSCALE_UNAVAILABLE",
    "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.",
  );

  let status: { code: number; stdout: string };
  try {
    status = await run(["status", "--json"], STATUS_TIMEOUT_MS);
  } catch {
    throw unavailable;
  }
  if (status.code !== 0) throw unavailable;
  const magicDnsName = parseMagicDnsName(status.stdout);
  if (magicDnsName === undefined) {
    throw new PairError(
      "TAILSCALE_NO_MAGICDNS",
      "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.",
    );
  }
  const baseUrl = tailscaleBaseUrl(magicDnsName, input.servePort);
  const port = String(input.servePort);
  const otherNode = new PairError(
    "TAILSCALE_SERVES_OTHER_NODE",
    `Tailscale Serve on HTTPS port ${port} already fronts a different Jhin node. Pass --tailscale-serve-port to publish this one on another port.`,
  );

  const existing = await probe(baseUrl);
  if (existing.kind === "node") {
    if (existing.instance !== input.node.instance) throw otherNode;
    return { baseUrl, notes };
  }
  if (existing.kind === "other") {
    throw new PairError(
      "TAILSCALE_PORT_OCCUPIED",
      `HTTPS port ${port} on the tailnet already serves something that is not this Jhin node. Pass --tailscale-serve-port to publish this one on another port.`,
    );
  }

  // Where Tailscale Serve sends requests: the node as this machine reaches it.
  const target = localUrl(input.node.url);
  let served: { code: number };
  try {
    served = await run(["serve", "--bg", `--https=${port}`, target], SERVE_TIMEOUT_MS);
  } catch {
    served = { code: -1 };
  }
  if (served.code !== 0) {
    throw new PairError(
      "TAILSCALE_SERVE_FAILED",
      `tailscale serve failed for HTTPS port ${port}. Run \`tailscale serve --https=${port} --bg ${target}\` by hand to see why.`,
    );
  }
  notes.push(
    `Tailscale Serve now maps ${baseUrl} to this node and persists across restarts. Remove it with \`tailscale serve --https=${port} off\`.`,
    "Tailscale Serve reaches the node from 127.0.0.1: add 127.0.0.1 to jhin.http.trustProxy so the node tells tailnet clients apart (rate limits, device addresses).",
  );

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await pause();
    const probed = await probe(baseUrl);
    if (probed.kind === "node") {
      if (probed.instance !== input.node.instance) throw otherNode;
      return { baseUrl, notes };
    }
  }
  notes.push(
    "The HTTPS endpoint has not answered yet. First use can take a moment while Tailscale provisions certificates.",
  );
  return { baseUrl, notes };
}
