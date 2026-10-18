import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

import { startNodeHost, type NodeHost } from "@jhin/node-host";
import type { CommandInfo } from "@jhin/sdk";

const require = Module.createRequire(import.meta.url);

/** Package directories of the plugins this CLI ships with (`jhinDistribution`). */
function distribution(): string[] {
  const manifest = JSON.parse(
    Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { jhinDistribution?: string[] };
  return (manifest.jhinDistribution ?? []).map((name) =>
    Path.dirname(require.resolve(`${name}/package.json`)),
  );
}

const USAGE = `Usage:
  jhin serve [--watch]          run this node until interrupted
  jhin inspect                  print the node's live state as JSON
  jhin <command> [--key value]  run a registered command, e.g. jhin example.greet --name Ada
         [--input '<json>']     ...or pass the whole input as JSON
  jhin help                     list every command

Global options:
  --home <dir>                  Jhin home (default: $JHIN_HOME or ~/.jhin)
  --cwd <dir>                   project directory (default: current directory)`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** `--name Ada --count 2 --flag` → { name: "Ada", count: 2, flag: true } (JSON values are parsed). */
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

const GLOBAL_OPTIONS = new Set(["home", "cwd", "input", "watch"]);

/** `--name Ada --count 2 --flag` → { name: "Ada", count: 2, flag: true }; JSON values are parsed. */
function inputFromOptions(options: ReadonlyMap<string, string | true>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of options) {
    if (GLOBAL_OPTIONS.has(key)) continue;
    if (value === true) {
      input[key] = true;
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
  const global = {
    ...(typeof home === "string" ? { home } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
  };

  if (command === undefined || command === "help" || command === "--help") {
    if (command === undefined) process.stdout.write(`${USAGE}\n`);
    else
      await withHost(global, async (host) =>
        process.stdout.write(
          `${USAGE}\n\nCommands:\n${describeCommands(host.kernel.commands.list())}\n`,
        ),
      );
    return 0;
  }

  if (command === "serve") {
    const host = await startNodeHost({
      distribution: distribution(),
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
        `logs: ${host.log.file}\n`,
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await host.stop();
    return 0;
  }

  if (command === "inspect") {
    await withHost(global, async (host) =>
      print(await host.kernel.commands.execute("host.inspect", {})),
    );
    return 0;
  }

  if (rest.length > 0) {
    process.stderr.write(`Unexpected arguments: ${rest.join(" ")}\n${USAGE}\n`);
    return 2;
  }
  return withHost(global, async (host) => {
    const known = host.kernel.commands.list();
    if (!known.some((info) => info.name === command)) {
      process.stderr.write(
        `Unknown command: ${command}\n\nCommands:\n${describeCommands(known)}\n`,
      );
      return 2;
    }
    const raw = parsed.options.get("input");
    const input = typeof raw === "string" ? JSON.parse(raw) : inputFromOptions(parsed.options);
    try {
      print(await host.kernel.commands.execute(command, input));
      return 0;
    } catch (error) {
      const info = error as { code?: string; message?: string; details?: unknown };
      process.stderr.write(
        `${JSON.stringify({ error: { code: info.code, message: info.message, details: info.details } }, null, 2)}\n`,
      );
      return 1;
    }
  });
}

process.exitCode = await main(process.argv.slice(2));
