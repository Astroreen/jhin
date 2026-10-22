// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/tailscale/src/tailscale.ts and
// resolveTailscalePairingBase / resolveTailscaleLocalTarget in apps/server/src/cli/pair.ts.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  PairError,
  localUrl,
  probeNode,
  type Probe,
  type RuntimeState,
} from "./pair.ts";

const SERVE_TIMEOUT_MS = 10_000;
/** Shown on every run, a kept mapping too: the setting is easy to miss once. */
const TRUST_PROXY_NOTE =
  "Tailscale Serve reaches the node from 127.0.0.1: add 127.0.0.1 to jhin.http.trustProxy so the node tells tailnet clients apart (rate limits, device addresses).";

/** `status --json` lists every peer: a large tailnet answers slowly and at length. */
const STATUS_TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
/** Tailscale provisions a certificate on a fresh mapping's first request, which takes a few seconds. */
const PROBE_ATTEMPTS = 5;

/** Runs `tailscale <args>`; rejects only when it cannot be started. */
export type TailscaleRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr?: string }>;

const runTailscale: TailscaleRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    ChildProcess.execFile(
      process.platform === "win32" ? "tailscale.exe" : "tailscale",
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number" && !error.killed) reject(error);
        else {
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
            stdout,
            stderr,
          });
        }
      },
    );
  });

/** Two proxy targets compared as URLs: `http://127.0.0.1:7777/` is `http://127.0.0.1:7777`. */
function sameTarget(shown: string, ours: string | undefined): boolean {
  if (ours === undefined || !URL.canParse(shown) || !URL.canParse(ours)) return false;
  const a = new URL(shown);
  const b = new URL(ours);
  return (
    a.origin === b.origin && a.pathname.replace(/\/+$/u, "") === b.pathname.replace(/\/+$/u, "")
  );
}

/**
 * Whether `tailscale serve status --json` leaves HTTPS port `port` to us: no
 * handler at all, or only web handlers proxying to targets `jhin pair` made
 * itself on this port (`ours`, the node's last address there). A TCP forward, a file or text
 * handler, a funneled port, or any proxy someone else made is never taken.
 */
export function replaceable(statusJson: string, port: number, ours: string | undefined): boolean {
  let status: {
    TCP?: Record<string, { TCPForward?: unknown; HTTPS?: unknown; HTTP?: unknown }>;
    Web?: Record<string, { Handlers?: Record<string, Record<string, unknown>> }>;
  };
  try {
    status = JSON.parse(statusJson === "" ? "{}" : statusJson) as typeof status;
  } catch {
    return false;
  }
  // A funneled port is public: re-pointing it would publish the node to the internet.
  if (funneled(statusJson, port)) return false;
  const tcp = status.TCP?.[String(port)];
  if (tcp === undefined) return true;
  if (tcp.TCPForward !== undefined) return false;
  const handlers = Object.entries(status.Web ?? {})
    .filter(([host]) => host.endsWith(`:${port}`))
    .flatMap(([, web]) => Object.entries(web.Handlers ?? {}));
  // A port that is taken but shows no handler is not known to be ours, and
  // `serve` rewrites only `/`: a handler on another path would stay beside it.
  return (
    handlers.length > 0 &&
    handlers.every(
      ([path, handler]) =>
        path === "/" &&
        Object.keys(handler).every((key) => key === "Proxy") &&
        typeof handler["Proxy"] === "string" &&
        sameTarget(handler["Proxy"], ours),
    )
  );
}

/** Whether Funnel publishes HTTPS port `port` (or the status cannot be read). */
function funneled(statusJson: string, port: number): boolean {
  try {
    const status = JSON.parse(statusJson === "" ? "{}" : statusJson) as {
      AllowFunnel?: Record<string, unknown>;
    };
    return Object.entries(status.AllowFunnel ?? {}).some(
      ([host, on]) => on === true && host.endsWith(`:${port}`),
    );
  } catch {
    return true;
  }
}

/**
 * The target `jhin pair --tailscale` last mapped on each HTTPS port, so it
 * repairs only its own mapping (D1189). One per port: a new one replaces the
 * old, so an address mapped long ago never claims a later hand-made mapping.
 */
export interface OwnMappings {
  target(port: number): string | undefined;
  remember(port: number, target: string): void;
}

/** Own mappings kept in a file of the home (0600), written whole. */
export function fileMappings(file: string): OwnMappings {
  const read = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(Fs.readFileSync(file, "utf8")) as { ports?: unknown };
      return typeof parsed.ports === "object" && parsed.ports !== null
        ? Object.fromEntries(
            Object.entries(parsed.ports).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    } catch {
      return {};
    }
  };
  return {
    target: (port) => read()[String(port)],
    remember(port, target) {
      const ports = { ...read(), [String(port)]: target };
      Fs.mkdirSync(Path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      Fs.writeFileSync(temporary, `${JSON.stringify({ ports })}\n`, { mode: 0o600 });
      Fs.renameSync(temporary, file);
    },
  };
}

/** One short line of what `tailscale` said, for an error the user can act on. */
const said = (stderr: string | undefined) => {
  const line = stderr
    ?.split("\n")
    .find((text) => text.trim() !== "")
    ?.trim();
  return line === undefined ? "" : ` Tailscale said: ${line.slice(0, 300)}`;
};

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
  readonly mappings: OwnMappings;
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

  let serveStatus: { code: number; stdout: string };
  try {
    serveStatus = await run(["serve", "status", "--json"], STATUS_TIMEOUT_MS);
  } catch {
    throw unavailable;
  }
  if (serveStatus.code !== 0) throw unavailable;
  // Never pair through a port Funnel publishes to the internet, a kept mapping
  // of this node included: the node is not meant to be public (D1189).
  if (funneled(serveStatus.stdout, input.servePort)) {
    throw new PairError(
      "TAILSCALE_PORT_FUNNELED",
      `HTTPS port ${port} is public through Tailscale Funnel. Turn Funnel off for it (\`tailscale funnel --https=${port} off\`) or pass --tailscale-serve-port.`,
    );
  }

  const existing = await probe(baseUrl);
  if (existing.kind === "node") {
    if (existing.instance !== input.node.instance) throw otherNode;
    return { baseUrl, notes: [TRUST_PROXY_NOTE] };
  }
  if (existing.kind === "other") {
    throw new PairError(
      "TAILSCALE_PORT_OCCUPIED",
      `HTTPS port ${port} on the tailnet already serves something that is not this Jhin node. Pass --tailscale-serve-port to publish this one on another port.`,
    );
  }

  // Nothing that answers as this node is there. Only an empty port, or a
  // mapping `jhin pair` made itself (a node's old address), is taken over.
  if (!replaceable(serveStatus.stdout, input.servePort, input.mappings.target(input.servePort))) {
    throw new PairError(
      "TAILSCALE_PORT_OCCUPIED",
      `HTTPS port ${port} on the tailnet already serves something that is not this Jhin node. Pass --tailscale-serve-port to publish this one on another port.`,
    );
  }

  // Where Tailscale Serve sends requests: the node as this machine reaches it.
  const target = localUrl(input.node.url);
  let served: { code: number; stderr?: string };
  try {
    served = await run(["serve", "--bg", `--https=${port}`, target], SERVE_TIMEOUT_MS);
  } catch {
    served = { code: -1 };
  }
  if (served.code !== 0) {
    throw new PairError(
      "TAILSCALE_SERVE_FAILED",
      `tailscale serve failed for HTTPS port ${port}. Run \`tailscale serve --https=${port} --bg ${target}\` by hand to see why.${said(served.stderr)}`,
    );
  }
  // The mapping exists now: failing to note it costs only a later repair.
  try {
    input.mappings.remember(input.servePort, target);
  } catch (error) {
    notes.push(
      `Could not record this mapping (${String(error)}); a later run will not repair it on its own.`,
    );
  }
  notes.push(
    `Tailscale Serve now maps ${baseUrl} to this node and persists across restarts. Remove it with \`tailscale serve --https=${port} off\`.`,
    TRUST_PROXY_NOTE,
  );

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await pause();
    const probed = await probe(baseUrl);
    // The mapping made above stays when this fails: the error says how to remove it.
    const stays = ` The mapping made stays: remove it with \`tailscale serve --https=${port} off\`.`;
    if (probed.kind === "node") {
      if (probed.instance !== input.node.instance) {
        throw new PairError(otherNode.code, `${otherNode.message}${stays}`);
      }
      return { baseUrl, notes };
    }
    // Something else answers on the fresh mapping: never hand out a link to it.
    if (probed.kind === "other") {
      throw new PairError(
        "TAILSCALE_PORT_OCCUPIED",
        `HTTPS port ${port} on the tailnet answers as something that is not this Jhin node. Check \`tailscale serve status\`.${stays}`,
      );
    }
  }
  notes.push(
    "The HTTPS endpoint has not answered yet. First use can take a moment while Tailscale provisions certificates.",
  );
  return { baseUrl, notes };
}
