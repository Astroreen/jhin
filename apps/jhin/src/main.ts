#!/usr/bin/env node
import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

import { resolveHome, startNodeHost, type NodeHost } from "@jhin/node-host";
import { createMcpServer } from "@jhin/mcp-bridge";
import { connectWebSocket, createRpcClient } from "@jhin/rpc";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CommandInfo, PermissionEntry } from "@jhin/sdk";

import { parseArgv, type Args } from "./args.ts";
import {
  PairError,
  discoverNode,
  formatPairOutput,
  pairingNotes,
  shellAccessNotes,
  shellAccessUnknown,
  parsePairFlags,
  reachableBaseUrl,
  type PairingLink,
} from "./pair.ts";
import { fileMappings, publishOverTailscale } from "./tailscale.ts";

const require = Module.createRequire(import.meta.url);

// The desktop app runs this CLI with its own Node through ELECTRON_RUN_AS_NODE
// (docs/plans/desktop.md, D512); what the node starts (agents, terminals,
// tools) must not inherit it, or an Electron app it launches runs as Node.
delete process.env["ELECTRON_RUN_AS_NODE"];

/**
 * Package directories of the plugins this CLI ships with. A mode is a set of
 * plugins (D21): `serve` = `jhinDistribution`, `serve --ui` adds `jhinUi`,
 * `client` = `jhinClient` (the web client alone, talking to remote nodes).
 */
function distribution(mode: "serve" | "ui" | "client" = "serve"): string[] {
  const manifest = JSON.parse(
    Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    jhinDistribution?: string[];
    jhinUi?: string[];
    jhinClient?: string[];
  };
  const names =
    mode === "client"
      ? (manifest.jhinClient ?? [])
      : [...(manifest.jhinDistribution ?? []), ...(mode === "ui" ? (manifest.jhinUi ?? []) : [])];
  return names.map((name) => Path.dirname(require.resolve(`${name}/package.json`)));
}

const USAGE = `Usage:
  jhin serve [--watch] [--ui]   run this node until interrupted; --ui also serves the web client
  jhin client [--watch]         serve only the web client, which connects to remote nodes
  jhin inspect                  print the node's live state as JSON
  jhin pair                     print a one-time pairing link and its QR code for another device
         [--label <name>]       ...shown in Authorized clients (default: jhin pair)
         [--ttl <minutes>]      ...how long the code is valid (default: 5)
         [--permission <grant>] ...repeatable; limits what the paired device can do
                                   (default: every permission the token holds)
         [--base-url <url>]     ...the address other devices reach the node by
         [--tailscale]          ...publish the node over Tailscale Serve HTTPS and pair through
                                   the tailnet URL (never to the internet)
         [--tailscale-serve-port <port>]  ...its HTTPS port (default: 443)
         [--json]               ...print the pairing link as JSON instead
  jhin mcp                      serve every command as an MCP tool over stdio
  jhin <command> [--key value]  run a registered command, e.g. jhin example.greet --name Ada
         [--input '<json>']     ...or pass the whole input as JSON
  jhin help                     list every command

Global options:
  --home <dir>                  Jhin home (default: $JHIN_HOME or ~/.jhin)
  --cwd <dir>                   project directory (default: current directory)
  --plugin-dir <dir>            also load the plugin package in <dir> (several joined by
                                "${Path.delimiter}"); it wins over the other locations (D15)
  --url <url>                   run against a running node (ws://host:port/rpc or http://host:port)
                                instead of booting the plugins in this process
  --token <token>               the node's access token (default: read from the home)`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const GLOBAL_OPTIONS = new Set([
  "home",
  "cwd",
  "input",
  "watch",
  "help",
  "url",
  "token",
  "ui",
  "plugin-dir",
]);

/**
 * `--name Ada --count 2 --flag` → { name: "Ada", count: 2, flag: true }. Values
 * are parsed as JSON unless the command's input schema declares the property a
 * string, so `--name 42` stays "42".
 */
function inputFromOptions(
  options: ReadonlyMap<string, string | true>,
  command: CommandInfo,
): Record<string, unknown> {
  const properties =
    (command.inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined)
      ?.properties ?? {};
  const input: Record<string, unknown> = {};
  for (const [key, value] of options) {
    if (GLOBAL_OPTIONS.has(key)) continue;
    if (value === true || properties[key]?.type === "string") {
      input[key] = value;
      continue;
    }
    try {
      input[key] = JSON.parse(value);
    } catch {
      input[key] = value;
    }
  }
  return input;
}

/** Where commands run: the plugins booted in this process, or a running node. */
interface Target {
  list(): Promise<readonly CommandInfo[]>;
  execute(name: string, input: unknown): Promise<unknown>;
}

async function withHost<T>(
  options: { home?: string; cwd?: string; dev?: readonly string[]; watch?: boolean },
  run: (host: NodeHost) => Promise<T>,
): Promise<T> {
  const host = await startNodeHost({
    distribution: distribution(),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.dev === undefined ? {} : { dev: options.dev }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
  });
  try {
    return await run(host);
  } finally {
    await host.stop();
  }
}

/** `ws://host:port/rpc` from `http://host:port`, `ws://host:port` or a full RPC URL. */
function rpcUrl(url: string): string {
  const parsed = new URL(url.replace(/^http/, "ws"));
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = "/rpc";
  return parsed.href;
}

/** The token of the node whose home is `home`, as written by jhin.auth-token. */
function localToken(home: string | undefined): string | undefined {
  const file = Path.join(resolveHome(home).root, "data", "jhin.auth-token", "token");
  return Fs.existsSync(file) ? Fs.readFileSync(file, "utf8").trim() : undefined;
}

async function withTarget<T>(
  options: { home?: string; cwd?: string; dev?: readonly string[]; url?: string; token?: string },
  run: (target: Target) => Promise<T>,
): Promise<T> {
  if (options.url === undefined) {
    return withHost(options, (host) =>
      run({
        list: async () => host.kernel.commands.list(),
        execute: (name, input) => host.kernel.commands.execute(name, input),
      }),
    );
  }
  const url = rpcUrl(options.url);
  const token = options.token ?? localToken(options.home);
  let attempts = 0;
  const client = createRpcClient({
    connect: () => connectWebSocket(url, token),
    // A CLI run should fail fast instead of waiting for the node forever.
    retryDelay: () => {
      attempts += 1;
      if (attempts > 3) client.close();
      return 200;
    },
  });
  try {
    return await run({
      list: () => client.call<CommandInfo[]>("host.commands.list"),
      execute: (name, input) => client.call(name, input),
    });
  } finally {
    client.close();
  }
}

/** "rpc: ws://…/rpc" when the node serves RPC, else nothing. */
async function rpcEndpoint(host: NodeHost): Promise<string> {
  if (!host.kernel.commands.list().some((command) => command.name === "http.info")) return "";
  const { url } = (await host.kernel.commands.execute("http.info", {})) as { url: string };
  return `rpc: ${rpcUrl(url)}\n`;
}

/** "ui: http://…/" when this node serves the web client, else nothing. */
async function uiEndpoint(host: NodeHost): Promise<string> {
  if (!host.kernel.commands.list().some((command) => command.name === "web-ui.info")) return "";
  const { url } = (await host.kernel.commands.execute("web-ui.info", {})) as { url: string };
  return `ui: ${url}\n`;
}

/**
 * `jhin pair` (docs/plans/security.md D1185): a pairing code from the running
 * node (D1184) or `--url`, printed as T3's block with a terminal QR code.
 */
async function pair(
  args: Args,
  remote: { home?: string; url?: string; token?: string },
): Promise<number> {
  const { options } = args;
  const option = (key: string) => {
    const value = options.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const parsed = parsePairFlags(args, remote.url !== undefined);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const { permissions, ttlMinutes, tailscale, servePort } = parsed;
  let url = remote.url;
  let baseUrl = option("base-url");
  const notes: string[] = [];
  try {
    if (url === undefined) {
      const node = await discoverNode(remote.home);
      url = node.url;
      if (tailscale) {
        const published = await publishOverTailscale({
          node,
          servePort,
          mappings: fileMappings(
            Path.join(resolveHome(remote.home).root, "cli", "tailscale-serve.json"),
          ),
        });
        baseUrl = published.baseUrl;
        notes.push(...published.notes);
      }
    }
  } catch (error) {
    if (!(error instanceof PairError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const origin = new URL(url.replace(/^ws/, "http")).origin;
  baseUrl ??= reachableBaseUrl(origin);
  return withTarget({ ...remote, url }, async (target) => {
    let link: PairingLink;
    try {
      link = (await target.execute("auth.pairing.create", {
        label: option("label") ?? "jhin pair",
        ...(permissions.length > 0 ? { permissions } : {}),
        ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
        baseUrl,
      })) as PairingLink;
    } catch (error) {
      // A Tailscale mapping made above stays: say so, and how to remove it.
      for (const note of notes) process.stderr.write(`Note: ${note}\n`);
      throw error;
    }
    try {
      const { permissions: entries } = (await target.execute("auth.permissions.list", {})) as {
        permissions: PermissionEntry[];
      };
      notes.push(...shellAccessNotes(link.permissions, entries));
    } catch (error) {
      // A token without auth.read still pairs; any other failure is said, never hidden.
      notes.push(shellAccessUnknown(error));
    }
    if (options.get("json") === true) {
      // The notes too: a Tailscale mapping outlives this run and says how to remove it.
      print({ ...link, ...(notes.length > 0 ? { notes } : {}) });
      return 0;
    }
    let nodeLabel = new URL(origin).host;
    try {
      nodeLabel = ((await target.execute("host.identity", {})) as { hostname: string }).hostname;
    } catch {
      // A token without host.identity still pairs; the address names the node.
    }
    const pairingUrl = link.url ?? `${baseUrl}/pair#token=${link.code}`;
    process.stdout.write(
      formatPairOutput({
        nodeLabel,
        origin,
        pairingUrl,
        code: link.code,
        expiresAt: link.expiresAt,
        notes: [...notes, ...pairingNotes(pairingUrl)],
      }),
    );
    return 0;
  });
}

function describeCommands(commands: readonly CommandInfo[]): string {
  return commands
    .map((command) => `  ${command.name.padEnd(28)} ${command.description}`)
    .join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const [command, ...rest] = parsed.positionals;
  const home = parsed.options.get("home");
  const cwd = parsed.options.get("cwd");
  const url = parsed.options.get("url");
  const token = parsed.options.get("token");
  const pluginDir = parsed.options.get("plugin-dir");
  const global = {
    ...(typeof home === "string" ? { home } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    // The dev layer (D15): the desktop app adds its client plugin this way (D514).
    ...(typeof pluginDir === "string"
      ? {
          dev: pluginDir
            .split(Path.delimiter)
            .filter((dir) => dir !== "")
            .map((dir) => Path.resolve(dir)),
        }
      : {}),
  };
  const remote = {
    ...global,
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof token === "string" ? { token } : {}),
  };

  if (command === undefined || command === "help" || parsed.options.has("help")) {
    if (command === undefined) process.stdout.write(`${USAGE}\n`);
    else
      await withTarget(remote, async (target) =>
        process.stdout.write(`${USAGE}\n\nCommands:\n${describeCommands(await target.list())}\n`),
      );
    return 0;
  }

  if (command === "serve" || command === "client") {
    const mode =
      command === "client" ? "client" : parsed.options.get("ui") === true ? "ui" : "serve";
    const host = await startNodeHost({
      distribution: distribution(mode),
      watch: parsed.options.get("watch") === true,
      ...global,
    });
    const snapshot = host.kernel.inspect();
    const active = snapshot.plugins.filter((plugin) => plugin.status === "active").length;
    const problems = snapshot.plugins.filter(
      (plugin) => plugin.status === "failed" || plugin.status === "blocked",
    );
    process.stderr.write(
      `jhin node ${host.nodeId} running: ${active} plugins active, ${problems.length} with problems\n` +
        problems
          .map((plugin) => `  ${plugin.status} ${plugin.id}: ${plugin.error?.message ?? ""}\n`)
          .join("") +
        (await rpcEndpoint(host)) +
        (await uiEndpoint(host)) +
        `logs: ${host.log.file}\n`,
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await host.stop();
    return 0;
  }

  if (command === "mcp") {
    // stdout is the MCP channel from here on: everything else goes to the log file or stderr.
    await withTarget(remote, async (target) => {
      const server = createMcpServer({
        list: () => target.list(),
        execute: (name, input) => target.execute(name, input),
      });
      const finished = new Promise<void>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP SDK Server only offers onclose
        server.onclose = resolve;
        process.stdin.once("end", resolve);
      });
      await server.connect(new StdioServerTransport() as unknown as Transport);
      await finished;
    });
    return 0;
  }

  if (command === "pair") {
    if (rest.length > 0) {
      process.stderr.write(`Unexpected arguments: ${rest.join(" ")}\n${USAGE}\n`);
      return 2;
    }
    return pair(parsed, remote);
  }

  if (command === "inspect") {
    await withTarget(remote, async (target) => print(await target.execute("host.inspect", {})));
    return 0;
  }

  if (rest.length > 0) {
    process.stderr.write(`Unexpected arguments: ${rest.join(" ")}\n${USAGE}\n`);
    return 2;
  }
  return withTarget(remote, async (target) => {
    const known = await target.list();
    const info = known.find((candidate) => candidate.name === command);
    if (info === undefined) {
      process.stderr.write(
        `Unknown command: ${command}\n\nCommands:\n${describeCommands(known)}\n`,
      );
      return 2;
    }
    const raw = parsed.options.get("input");
    let input: unknown;
    if (typeof raw === "string") {
      try {
        input = JSON.parse(raw);
      } catch {
        process.stderr.write(`--input is not valid JSON: ${raw}\n`);
        return 2;
      }
    } else {
      input = inputFromOptions(parsed.options, info);
    }
    try {
      print(await target.execute(command, input));
      return 0;
    } catch (error) {
      const failure = error as { code?: string; message?: string; details?: unknown };
      process.stderr.write(
        `${JSON.stringify({ error: { code: failure.code, message: failure.message, details: failure.details } }, null, 2)}\n`,
      );
      return 1;
    }
  });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Anything not handled above (an unreachable node, a refused token) is one JSON line, not a stack.
  const failure = error as { code?: unknown; message?: unknown };
  process.stderr.write(
    `${JSON.stringify({ error: { code: failure.code ?? "ERROR", message: failure.message ?? String(error) } })}\n`,
  );
  process.exitCode = 1;
}
