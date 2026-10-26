// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/preview/PortScanner.ts
// (its parsers verbatim, the scan without Effect) and LSOF_LOCAL_HOST_TOKENS of
// packages/shared/src/preview.ts. docs/plans/preview.md, D950.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";

import { z } from "@jhin/sdk";

/** The terminal a server's process runs in. */
const LocalServerTerminal = z.object({ threadId: z.string(), terminalId: z.string() });
type LocalServerTerminal = z.output<typeof LocalServerTerminal>;

/** A browser-ready server on this machine (T3's `DiscoveredLocalServer`). */
export const DiscoveredLocalServer = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  url: z.string(),
  processName: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  terminal: LocalServerTerminal.nullable(),
});
export type DiscoveredLocalServer = z.output<typeof DiscoveredLocalServer>;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LSOF_TIMEOUT_MS = 5_000;
const PROC_FD_WALK_LIMIT = 50_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
/** `netstat -ano` lists every connection, not just listeners; ~80 bytes per row, sized for ~200k rows. */
const WINDOWS_NETSTAT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const WEB_PROBE_TIMEOUT_MS = 1_000;
const WEB_PROBE_CACHE_TTL_MS = 15_000;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type TerminalByProcessId = ReadonlyMap<number, LocalServerTerminal>;

function parseLsofOutput(
  raw: string,
  terminalByProcessId: TerminalByProcessId = new Map(),
): DiscoveredLocalServer[] {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const portMatch = parsePortFromLsofName(value);
      if (portMatch == null) continue;
      const url = `http://localhost:${portMatch}`;
      const key = `localhost:${portMatch}`;
      const terminal = pid === null ? null : (terminalByProcessId.get(pid) ?? null);
      const existing = seen.get(key);
      if (existing) {
        if (terminal === null) seen.set(key, { ...existing, terminal: null });
        continue;
      }
      seen.set(key, { host: "localhost", port: portMatch, url, processName, pid, terminal });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
}

function parsePortFromLsofName(name: string): number | null {
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
}

function parseWindowsListenerLine(line: string): {
  readonly host: string;
  readonly port: number;
  readonly pid: number | null;
} | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  // Foreign port `:0` identifies a listening TCP socket regardless of Windows locale.
  const fields = trimmed.split(/\s+/);
  if (fields.length < 4 || fields[0]?.toUpperCase() !== "TCP") return null;
  const localEndpoint = fields[1] ?? "";
  const foreignEndpoint = fields[2] ?? "";
  if (!foreignEndpoint.endsWith(":0")) return null;
  const lastColon = localEndpoint.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const host = localEndpoint.slice(0, lastColon);
  if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") return null;
  const port = Number(localEndpoint.slice(lastColon + 1));
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const pid = Number(fields.at(-1));
  return { host, port, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

export function parseTasklistProcessName(raw: string, pid: number): string | null {
  for (const line of raw.split(/\r?\n/g)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match && Number(match[2]) === pid) return match[1]!.replace(/\.exe$/i, "") || null;
  }
  return null;
}

function parseWindowsListenerOutput(
  raw: string,
  terminalByProcessId: TerminalByProcessId = new Map(),
): DiscoveredLocalServer[] {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const line of raw.split(/\r?\n/g)) {
    const parsed = parseWindowsListenerLine(line);
    if (!parsed) continue;
    const { port, pid } = parsed;
    const terminal = pid === null ? null : (terminalByProcessId.get(pid) ?? null);
    const existing = seen.get(port);
    if (existing) {
      if (terminal === null) seen.set(port, { ...existing, terminal: null });
      continue;
    }
    seen.set(port, {
      host: "localhost",
      port,
      url: `http://localhost:${port}`,
      processName: null,
      pid,
      terminal,
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
}

const PROC_TCP_LISTEN = "0A";

/** Each 32-bit word of the hex address is little-endian. */
function procLocalAddress(hex: string): boolean {
  if (hex.length === 8) {
    return hex === "00000000" || hex.endsWith("7F");
  }
  if (hex.length !== 32) return false;
  if (hex === "0".repeat(32) || hex === `${"0".repeat(24)}01000000`) return true;
  return hex.startsWith(`${"0".repeat(16)}FFFF0000`) && procLocalAddress(hex.slice(24));
}

export function parseProcNetTcp(raw: string): { readonly port: number; readonly inode: string }[] {
  const listeners: { port: number; inode: string }[] = [];
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, portHex] = fields[1]?.split(":") ?? [];
    if (fields[3] !== PROC_TCP_LISTEN || !address || !portHex) continue;
    if (!procLocalAddress(address.toUpperCase())) continue;
    const port = Number.parseInt(portHex, 16);
    const inode = fields[9];
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !inode) continue;
    listeners.push({ port, inode });
  }
  return listeners;
}

/** What the scan reads of the machine; tests give their own. */
export interface ScanHost {
  readonly platform: NodeJS.Platform;
  /**
   * Runs a program with its exit code; rejects on a failed start (`code: "ENOENT"`
   * when it is missing), a timeout or too much output.
   */
  run(
    command: string,
    args: readonly string[],
    options: { timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  readLink(path: string): Promise<string>;
  /** GET without following redirects: the status and two headers, or null when it failed. */
  probe(
    url: string,
  ): Promise<{ status: number; contentType: string | null; location: string | null } | null>;
  now(): number;
}

/**
 * T3's local server discovery (D950): the TCP listeners on this machine
 * (`lsof`, else `/proc` on Linux; `netstat` on Windows), kept only when a
 * terminal's process owns them, since sending HTTP to another app's binary
 * listener can crash it, and only when they answer HTTP or HTTPS with a page
 * or a redirect.
 */
export function createLocalServerScanner(host: ScanHost) {
  let lsofMissing = false;
  const webProbes = new Map<string, { pid: number | null; isWeb: boolean; expiresAt: number }>();

  async function findSocketOwners(inodes: ReadonlySet<string>, first: Iterable<number>) {
    const owners = new Map<string, { pid: number; processName: string | null }>();
    const all = (await host.readDir("/proc").catch(() => [])).filter((entry) =>
      /^\d+$/.test(entry),
    );
    // The terminals' processes first: the budget then never runs out before them.
    const preferred = new Set([...first].map(String).filter((pid) => all.includes(pid)));
    const pids = [...preferred, ...all.filter((pid) => !preferred.has(pid))];
    let budget = PROC_FD_WALK_LIMIT;
    for (const pidText of pids) {
      if (owners.size === inodes.size || budget <= 0) break;
      const fds = await host.readDir(`/proc/${pidText}/fd`).catch(() => []);
      const walked = fds.slice(0, budget);
      budget -= walked.length;
      // 16 links at a time, as T3 reads them.
      const links: string[] = [];
      for (let start = 0; start < walked.length; start += 16) {
        links.push(
          ...(await Promise.all(
            walked
              .slice(start, start + 16)
              .map((fd) => host.readLink(`/proc/${pidText}/fd/${fd}`).catch(() => "")),
          )),
        );
      }
      const held = links.flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? []);
      const matched = held.filter((inode) => inodes.has(inode) && !owners.has(inode));
      if (matched.length === 0) continue;
      const processName = await host
        .readFile(`/proc/${pidText}/comm`)
        .then((name) => name.trim() || null)
        .catch(() => null);
      for (const inode of matched) owners.set(inode, { pid: Number(pidText), processName });
    }
    return owners;
  }

  async function scanProcListeners(terminals: TerminalByProcessId) {
    if (host.platform !== "linux") return null;
    const tables = await Promise.all(
      ["/proc/net/tcp", "/proc/net/tcp6"].map((path) => host.readFile(path).catch(() => null)),
    );
    if (tables.every((table) => table === null)) return null;
    const listeners = tables.flatMap((table) => (table === null ? [] : parseProcNetTcp(table)));
    const owners = await findSocketOwners(
      new Set(listeners.map((listener) => listener.inode)),
      terminals.keys(),
    );
    const seen = new Map<number, DiscoveredLocalServer>();
    for (const { port, inode } of listeners) {
      const owner = owners.get(inode) ?? null;
      const terminal = owner === null ? null : (terminals.get(owner.pid) ?? null);
      const existing = seen.get(port);
      if (existing && (existing.pid !== null || owner === null)) {
        if (terminal === null) seen.set(port, { ...existing, terminal: null });
        continue;
      }
      seen.set(port, {
        host: "localhost",
        port,
        url: `http://localhost:${port}`,
        processName: owner?.processName ?? null,
        pid: owner?.pid ?? null,
        terminal: existing ? null : terminal,
      });
    }
    return [...seen.values()].toSorted((left, right) => left.port - right.port);
  }

  async function probeWebUrl(url: string): Promise<boolean> {
    const response = await host.probe(url);
    if (response === null) return false;
    if (NAVIGATION_REDIRECT_STATUSES.has(response.status) && response.location?.trim()) return true;
    if (response.status < 200 || response.status >= 300) return false;
    if (response.status === 204 || response.status === 205) return false;
    const contentType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    return contentType === "text/html" || contentType === "application/xhtml+xml";
  }

  async function isWeb(url: string, pid: number | null): Promise<boolean> {
    const cached = webProbes.get(url);
    if (cached !== undefined && cached.pid === pid && cached.expiresAt > host.now()) {
      return cached.isWeb;
    }
    const web = await probeWebUrl(url);
    // Ports come and go: expired probes leave, so the cache stays as small as the live servers.
    for (const [key, probe] of webProbes) if (probe.expiresAt <= host.now()) webProbes.delete(key);
    webProbes.set(url, { pid, isWeb: web, expiresAt: host.now() + WEB_PROBE_CACHE_TTL_MS });
    return web;
  }

  async function probeWebServers(servers: readonly DiscoveredLocalServer[]) {
    // A listener alone does not identify its protocol. Sending HTTP or TLS to
    // another app's binary RPC listener can crash it before classification.
    const owned = servers.filter((server) => server.terminal !== null);
    const visible = await Promise.all(
      owned.map(async (server) => {
        for (const url of [
          `http://${server.host}:${server.port}`,
          `https://${server.host}:${server.port}`,
        ]) {
          if (await isWeb(url, server.pid)) return { ...server, url };
        }
        return null;
      }),
    );
    return visible.filter((server): server is DiscoveredLocalServer => server !== null);
  }

  async function withWindowsProcessNames(servers: DiscoveredLocalServer[]) {
    return Promise.all(
      servers.map(async (server) => {
        if (server.pid === null || server.processName !== null) return server;
        const output = await host
          .run("tasklist.exe", ["/FO", "CSV", "/NH", "/FI", `PID eq ${server.pid}`], {
            timeout: WINDOWS_LISTENER_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
          })
          .then((result) => (result.exitCode === 0 ? result.stdout : ""))
          .catch(() => "");
        return { ...server, processName: parseTasklistProcessName(output, server.pid) };
      }),
    );
  }

  /**
   * T3's `configuredUrls` (D1480): each a project script's preview URL, probed
   * as a listener is, listed in place of a listener on its host and port.
   */
  async function withConfigured(
    discovered: readonly DiscoveredLocalServer[],
    configuredUrls: readonly string[],
  ): Promise<DiscoveredLocalServer[]> {
    const visible = new Map<string, DiscoveredLocalServer>();
    const keyOf = (host: string, port: number) => `${host}:${port}`;
    for (const raw of normalizeConfiguredUrls(configuredUrls)) {
      const url = new URL(raw);
      const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      const key = keyOf(url.hostname, port);
      if (visible.has(key) || !(await isWeb(raw, null))) continue;
      const listener = discovered.find(
        (server) => server.port === port && LOOPBACK_HOSTS.has(url.hostname),
      );
      visible.set(key, {
        host: url.hostname,
        port,
        url: raw,
        processName: listener?.processName ?? null,
        pid: listener?.pid ?? null,
        terminal: listener?.terminal ?? null,
      });
    }
    for (const server of discovered) {
      const key = keyOf(server.host, server.port);
      const shadowed = [...visible.values()].some(
        (configured) => configured.port === server.port && LOOPBACK_HOSTS.has(configured.host),
      );
      if (!visible.has(key) && !shadowed) visible.set(key, server);
    }
    return [...visible.values()].toSorted((left, right) => left.port - right.port);
  }

  async function scanTerminals(terminals: TerminalByProcessId): Promise<DiscoveredLocalServer[]> {
    if (terminals.size === 0) return [];
    if (host.platform === "win32") {
      const netstat = (protocol: "tcp" | "tcpv6") =>
        host.run("netstat.exe", ["-ano", "-p", protocol], {
          timeout: WINDOWS_LISTENER_TIMEOUT_MS,
          maxBuffer: WINDOWS_NETSTAT_MAX_OUTPUT_BYTES,
        });
      // One failed query leaves a partial snapshot: show nothing rather than half.
      const listeners = await Promise.all([netstat("tcp"), netstat("tcpv6")]).then(
        ([tcp4, tcp6]) =>
          tcp4.exitCode !== 0 || tcp6.exitCode !== 0
            ? []
            : parseWindowsListenerOutput(`${tcp4.stdout}\n${tcp6.stdout}`, terminals),
        () => [],
      );
      return withWindowsProcessNames(await probeWebServers(listeners));
    }
    if (!lsofMissing) {
      const listeners = await host
        .run("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"], {
          timeout: LSOF_TIMEOUT_MS,
          // Partial output could hide another app's listener on an owned port.
          maxBuffer: 1024 * 1024,
        })
        .then(
          // lsof exits 1 after any warning (an unreadable mount) with its output whole (T3).
          // A failed run that printed nothing (no permission, a broken lsof) tells nothing: /proc then.
          (result) =>
            result.exitCode !== 0 && result.stdout.trim() === ""
              ? null
              : parseLsofOutput(result.stdout, terminals),
          (error: unknown) => {
            if ((error as { code?: unknown }).code === "ENOENT") lsofMissing = true;
            return null;
          },
        );
      if (listeners !== null) return probeWebServers(listeners);
    }
    return probeWebServers((await scanProcListeners(terminals)) ?? []);
  }

  return {
    /**
     * The browser-ready servers the given terminal processes listen on, and
     * the configured URLs that answer, by port.
     */
    async scan(
      terminals: TerminalByProcessId,
      configuredUrls: readonly string[] = [],
    ): Promise<DiscoveredLocalServer[]> {
      const discovered = await scanTerminals(terminals);
      return configuredUrls.length === 0 ? discovered : withConfigured(discovered, configuredUrls);
    },
  };
}

/**
 * T3's `normalizeConfiguredUrls`: http and https only, `0.0.0.0` read as `localhost`, once
 * each. Only this machine's loopback is probed: a URL of another host would make the node
 * a probe of whatever its network reaches, for any caller that may list servers.
 */
export function normalizeConfiguredUrls(urls: readonly string[]): string[] {
  const normalized = urls.flatMap((raw) => {
    if (raw.length > 2048) return [];
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return [];
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    if (url.hostname === "0.0.0.0") url.hostname = "localhost";
    if (!LOOPBACK_HOSTS.has(url.hostname) && url.hostname !== "[::1]") return [];
    return [url.href];
  });
  return [...new Set(normalized)];
}

/** This machine, through Node. */
export const nodeScanHost: ScanHost = {
  platform: process.platform,
  run: (command, args, options) =>
    new Promise((resolve, reject) => {
      ChildProcess.execFile(
        command,
        [...args],
        { ...options, windowsHide: true },
        (error, stdout) => {
          // A program that ran and exited non-zero: its output and code, for the caller to judge.
          if (error === null) resolve({ stdout, exitCode: 0 });
          else if (typeof error.code === "number" && !error.killed) {
            resolve({ stdout, exitCode: error.code });
          } else reject(error);
        },
      );
    }),
  readFile: (path) => Fs.promises.readFile(path, "utf8"),
  readDir: (path) => Fs.promises.readdir(path),
  readLink: (path) => Fs.promises.readlink(path),
  async probe(url) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(WEB_PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        location: response.headers.get("location"),
      };
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};
