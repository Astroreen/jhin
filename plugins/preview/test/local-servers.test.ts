// The cases follow T3 Code's apps/server/src/preview/PortScanner.test.ts (MIT, see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vite-plus/test";

import {
  createLocalServerScanner,
  normalizeConfiguredUrls,
  parseProcNetTcp,
  parseTasklistProcessName,
  type ScanHost,
} from "../src/local-servers.ts";

const TERMINAL = { threadId: "thread-1", terminalId: "term-1" };

type Probe = Awaited<ReturnType<ScanHost["probe"]>>;
const html: Probe = { status: 200, contentType: "text/html; charset=utf-8", location: null };

function fakeHost(options: {
  platform?: NodeJS.Platform;
  programs?: Record<string, string | Error>;
  exitCodes?: Record<string, number>;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  links?: Record<string, string>;
  probes?: Record<string, Probe>;
}) {
  const runs: string[] = [];
  const probed: string[] = [];
  const clock = { now: 0 };
  const host: ScanHost = {
    platform: options.platform ?? "darwin",
    async run(command, args) {
      runs.push([command, ...args].join(" "));
      const result = options.programs?.[command];
      if (result === undefined || result instanceof Error) {
        throw result ?? Object.assign(new Error(`${command}: not found`), { code: "ENOENT" });
      }
      return { stdout: result, exitCode: options.exitCodes?.[command] ?? 0 };
    },
    async readFile(path) {
      const file = options.files?.[path];
      if (file === undefined) throw new Error(`ENOENT ${path}`);
      return file;
    },
    async readDir(path) {
      const dir = options.dirs?.[path];
      if (dir === undefined) throw new Error(`ENOENT ${path}`);
      return dir;
    },
    async readLink(path) {
      const link = options.links?.[path];
      if (link === undefined) throw new Error(`ENOENT ${path}`);
      return link;
    },
    async probe(url) {
      probed.push(url);
      return options.probes?.[url] ?? null;
    },
    now: () => clock.now,
  };
  return { host, runs, probed, clock };
}

const LSOF = [
  "p4242",
  "cnode",
  "n*:5173",
  "n[::1]:5173",
  "p999",
  "cpostgres",
  "n127.0.0.1:5432",
  "",
].join("\n");

describe("local server discovery (D950)", () => {
  it("lists only servers a terminal's process runs, and only when they serve a page", async () => {
    const { host, probed } = fakeHost({
      programs: { lsof: LSOF },
      probes: { "http://localhost:5173": html },
    });
    const servers = await createLocalServerScanner(host).scan(new Map([[4242, TERMINAL]]));
    expect(servers).toEqual([
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "node",
        pid: 4242,
        terminal: TERMINAL,
      },
    ]);
    // Another app's listener is never sent HTTP: it may speak something else.
    expect(probed).toEqual(["http://localhost:5173"]);
  });

  it("never probes a port another process shares with a terminal's", async () => {
    // pid 4242 is the terminal's, pid 999 another app's, both on 5173.
    const lsof = ["p4242", "cnode", "n*:5173", "p999", "cother", "n127.0.0.1:5173", ""].join("\n");
    const { host, probed } = fakeHost({
      programs: { lsof },
      probes: { "http://localhost:5173": html },
    });
    expect(await createLocalServerScanner(host).scan(new Map([[4242, TERMINAL]]))).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("reads lsof's output when it exits 1 after a warning, as T3 does", async () => {
    const { host } = fakeHost({
      programs: { lsof: LSOF },
      exitCodes: { lsof: 1 },
      probes: { "http://localhost:5173": html },
    });
    const servers = await createLocalServerScanner(host).scan(new Map([[4242, TERMINAL]]));
    expect(servers.map((server) => server.port)).toEqual([5173]);
  });

  it("reads /proc when lsof fails without output", async () => {
    const tcp = ["header", "0: 00000000:1F90 00000000:0000 0A 0 0 0 0 0 777"].join("\n");
    const { host } = fakeHost({
      platform: "linux",
      programs: { lsof: "" },
      exitCodes: { lsof: 1 },
      files: { "/proc/net/tcp": tcp, "/proc/4242/comm": "node\n" },
      dirs: { "/proc": ["4242"], "/proc/4242/fd": ["3"] },
      links: { "/proc/4242/fd/3": "socket:[777]" },
      probes: { "http://localhost:8080": html },
    });
    const servers = await createLocalServerScanner(host).scan(new Map([[4242, TERMINAL]]));
    expect(servers.map((server) => server.port)).toEqual([8080]);
  });

  it("excludes HTTP errors, non-navigation responses and non-documents; follows to HTTPS", async () => {
    const lsof = ["p1", "cvite", "n*:3000", "n*:3001", "n*:3002", "n*:3003", "n*:3004", ""].join(
      "\n",
    );
    const { host } = fakeHost({
      programs: { lsof },
      probes: {
        "http://localhost:3000": { status: 500, contentType: "text/html", location: null },
        "http://localhost:3001": { status: 204, contentType: "text/html", location: null },
        "http://localhost:3002": { status: 200, contentType: "application/json", location: null },
        "http://localhost:3003": { status: 302, contentType: null, location: "/login" },
        "https://localhost:3004": html,
      },
    });
    const servers = await createLocalServerScanner(host).scan(new Map([[1, TERMINAL]]));
    expect(servers.map((server) => server.url)).toEqual([
      "http://localhost:3003",
      "https://localhost:3004",
    ]);
  });

  it("reads Linux listeners from /proc when lsof is missing, and stops spawning it", async () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1",
      "   1: 0100007F:0016 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 778 1",
      "   2: 0A00000F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 779 1",
      "",
    ].join("\n");
    const { host, runs } = fakeHost({
      platform: "linux",
      files: { "/proc/net/tcp": tcp, "/proc/4242/comm": "python3\n" },
      dirs: { "/proc": ["self", "4242"], "/proc/4242/fd": ["0", "7"] },
      links: { "/proc/4242/fd/0": "/dev/pts/1", "/proc/4242/fd/7": "socket:[777]" },
      probes: { "http://localhost:8080": html },
    });
    const scanner = createLocalServerScanner(host);
    const owners = new Map([[4242, TERMINAL]]);
    expect(await scanner.scan(owners)).toEqual([
      {
        host: "localhost",
        port: 8080,
        url: "http://localhost:8080",
        processName: "python3",
        pid: 4242,
        terminal: TERMINAL,
      },
    ]);
    await scanner.scan(owners);
    expect(runs.filter((run) => run.startsWith("lsof"))).toHaveLength(1);
  });

  it("parses Windows netstat listeners and names them with tasklist", async () => {
    const netstat = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242",
      "  TCP    127.0.0.1:5173         127.0.0.1:51000        ESTABLISHED     4242",
      "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
      "",
    ].join("\r\n");
    const { host } = fakeHost({
      platform: "win32",
      programs: {
        "netstat.exe": netstat,
        "tasklist.exe": '"node.exe","4242","Console","1","50,000 K"',
      },
      probes: { "http://localhost:5173": html },
    });
    const servers = await createLocalServerScanner(host).scan(new Map([[4242, TERMINAL]]));
    expect(servers).toMatchObject([{ port: 5173, pid: 4242, processName: "node" }]);
  });

  it("keeps a probe for 15 s, for the same process only", async () => {
    const { host, probed, clock } = fakeHost({
      programs: { lsof: LSOF },
      probes: { "http://localhost:5173": html },
    });
    const scanner = createLocalServerScanner(host);
    const owners = new Map([[4242, TERMINAL]]);
    await scanner.scan(owners);
    clock.now = 14_999;
    await scanner.scan(owners);
    expect(probed).toHaveLength(1);
    clock.now = 15_000;
    await scanner.scan(owners);
    expect(probed).toHaveLength(2);
  });

  it("lists a script's configured URL that answers, in place of its listener (D1480)", async () => {
    const { host } = fakeHost({
      programs: { lsof: LSOF },
      probes: {
        "http://localhost:5173/app": html,
        "http://localhost:5173": html,
        "http://localhost:3000/": html,
      },
    });
    const servers = await createLocalServerScanner(host).scan(new Map([[4242, TERMINAL]]), [
      "http://0.0.0.0:5173/app",
      "http://localhost:3000",
      "http://localhost:9999",
      "ftp://localhost:21",
    ]);
    expect(servers).toEqual([
      {
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000/",
        processName: null,
        pid: null,
        terminal: null,
      },
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/app",
        processName: "node",
        pid: 4242,
        terminal: TERMINAL,
      },
    ]);
    // A configured URL needs no terminal of its own.
    expect(
      await createLocalServerScanner(host).scan(new Map(), ["http://localhost:3000"]),
    ).toMatchObject([{ port: 3000 }]);
    expect(normalizeConfiguredUrls(["http://localhost:3000", "http://localhost:3000/"])).toEqual([
      "http://localhost:3000/",
    ]);
  });

  it("runs nothing while no terminal runs a process", async () => {
    const { host, runs } = fakeHost({ programs: { lsof: LSOF } });
    expect(await createLocalServerScanner(host).scan(new Map())).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("parses the tables as T3 does", () => {
    expect(parseTasklistProcessName('"vite.exe","12","Console","1","1 K"', 12)).toBe("vite");
    expect(parseTasklistProcessName('"vite.exe","12","Console","1","1 K"', 13)).toBeNull();
    // IPv6 any, and IPv4-mapped loopback.
    const tcp6 = [
      "header",
      "0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 0 0 0 0 0 11",
      "1: 0000000000000000FFFF00000100007F:0051 00000000000000000000000000000000:0000 0A 0 0 0 0 0 12",
    ].join("\n");
    expect(parseProcNetTcp(tcp6)).toEqual([
      { port: 80, inode: "11" },
      { port: 81, inode: "12" },
    ]);
  });
});
