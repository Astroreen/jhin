import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

import { resolveHome, startNodeHost, type NodeHost } from "@jhin/node-host";
import { createMcpServer } from "@jhin/mcp-bridge";
import { connectWebSocket, createRpcClient } from "@jhin/rpc";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CommandInfo } from "@jhin/sdk";

const require = Module.createRequire(import.meta.url);

/**
 * Package directories of the plugins this CLI ships with: `jhinDistribution`,
 * plus `jhinUi` when the node serves the web client too (D21: a mode is a set
 * of plugins).
 */
function distribution(options: { ui?: boolean } = {}): string[] {
  const manifest = JSON.parse(
    Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { jhinDistribution?: string[]; jhinUi?: string[] };
  const names = [
    ...(manifest.jhinDistribution ?? []),
    ...(options.ui === true ? (manifest.jhinUi ?? []) : []),
  ];
  return names.map((name) => Path.dirname(require.resolve(`${name}/package.json`)));
}

const USAGE = `Usage:
  jhin serve [--watch] [--ui]   run this node until interrupted; --ui also serves the web client
  jhin inspect                  print the node's live state as JSON
  jhin mcp                      serve every command as an MCP tool over stdio
  jhin <command> [--key value]  run a registered command, e.g. jhin example.greet --name Ada
         [--input '<json>']     ...or pass the whole input as JSON
  jhin help                     list every command

Global options:
  --home <dir>                  Jhin home (default: $JHIN_HOME or ~/.jhin)
  --cwd <dir>                   project directory (default: current directory)
  --url <url>                   run against a running node (ws://host:port/rpc or http://host:port)
                                instead of booting the plugins in this process
  --token <token>               the node's access token (default: read from the home)`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface Args {
  readonly positionals: readonly string[];
  /** Every `--key value`, `--key=value` or bare `--flag` (true), in order. */
  readonly options: ReadonlyMap<string, string | true>;
}

function parseArgv(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      options.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options.set(body, true);
    } else {
      options.set(body, next);
      index += 1;
    }
  }
  return { positionals, options };
}

const GLOBAL_OPTIONS = new Set(["home", "cwd", "input", "watch", "help", "url", "token", "ui"]);

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
  options: { home?: string; cwd?: string; watch?: boolean },
  run: (host: NodeHost) => Promise<T>,
): Promise<T> {
  const host = await startNodeHost({
    distribution: distribution(),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
  options: { home?: string; cwd?: string; url?: string; token?: string },
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
  const global = {
    ...(typeof home === "string" ? { home } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
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

  if (command === "serve") {
    const ui = parsed.options.get("ui") === true;
    const host = await startNodeHost({
      distribution: distribution({ ui }),
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
