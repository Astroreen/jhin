import * as Path from "node:path";

import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { LIVE_STREAMS_CAPABILITY, createMemoryStreams, type LiveStreams } from "@jhin/rpc";
import { definePlugin, z } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";
import {
  CloseTerminalInput,
  OpenTerminalInput,
  ResizeTerminalInput,
  TERMINALS_STREAM,
  TERMINAL_SESSIONS_CAPABILITY,
  TERMINAL_STREAM_PREFIX,
  TerminalId,
  TerminalSnapshot,
  TerminalSummary,
  TerminalThreadId,
  WriteTerminalInput,
} from "@jhin/terminal-api";

import { createHistoryFiles } from "./history.ts";
import { createProcessTableReader } from "./processes.ts";
import { loadNodePty } from "./pty.ts";
import { TerminalError, createSessions } from "./sessions.ts";

const CONFIG_SECTION = "jhin.terminal";

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
const Config = z
  .object({
    shell: z
      .string()
      .min(1)
      .optional()
      .meta({
        title: "Shell",
        description:
          "The program a terminal starts; $SHELL when unset (COMSPEC or PowerShell on Windows).",
        examples: ["/bin/zsh"],
      }),
    scrollback: z.number().int().min(100).max(100_000).default(5000).meta({
      title: "Scrollback lines",
      description: "How much of a terminal's output the node keeps for clients that open it later.",
    }),
    env: z
      .object({
        strip: z
          .array(z.string().min(1))
          .optional()
          .meta({
            title: "Variables to strip",
            description:
              "Names of the node's environment variables a terminal does not get; NAME_* matches a prefix.",
            examples: [["ANTHROPIC_API_KEY", "AWS_*"]],
          }),
        keep: z
          .array(z.string().min(1))
          .optional()
          .meta({
            title: "Variables to keep",
            description:
              "When set, the only variables of the node's environment a terminal gets; NAME_* matches a prefix.",
            examples: [["PATH", "HOME", "LANG", "LC_*"]],
          }),
      })
      .optional()
      .meta({
        title: "Environment",
        description:
          "Narrows the node's environment that terminals get (JHIN_*, VITE_* and the node's ports are always left out). Read when a shell starts.",
      }),
  })
  .meta({
    title: "Terminal",
    description: "Terminals in the folder of a thread's project, as T3 Code opens them.",
  });
type Config = z.output<typeof Config>;

export default definePlugin({
  activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    const log = context.services.tryGet<EventLog>(EVENTLOG_CAPABILITY);
    const paths = context.services.tryGet<HostPaths>(HOST_PATHS_CAPABILITY);
    const streams = createMemoryStreams({ log: context.log });
    const sessions = createSessions({
      streams,
      pty: loadNodePty,
      processTable: createProcessTableReader(),
      config: () => context.config.get<Config>(CONFIG_SECTION),
      log: context.log,
      // Output kept across node restarts (D464), where the node has a data folder.
      ...(paths === undefined
        ? {}
        : {
            history: createHistoryFiles(
              Path.join(paths.dataDir(context.plugin.id), "history"),
              context.log,
            ),
          }),
    });
    context.services.provide(TERMINAL_SESSIONS_CAPABILITY, sessions);
    // Sessions end with the plugin: their processes are stopped before it is gone.
    context.onDeactivate(() => sessions.dispose());

    if (live === undefined) {
      context.log.warn(
        "no rpc.streams@1: terminal output reaches clients only through terminals.get",
      );
    } else {
      // What a shell prints may hold secrets: reading it takes what terminals.get takes.
      const read = { permissions: ["terminals.read"] };
      context.subscriptions.add(live.serve(TERMINALS_STREAM, streams, read));
      context.subscriptions.add(live.serve(TERMINAL_STREAM_PREFIX, streams, read));
    }

    // A deleted or archived thread takes its terminals with it (D143, D466).
    if (log !== undefined) {
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          const record = event.payload as { id?: unknown; archivedAt?: unknown } | null;
          const gone =
            event.type === ThreadEvents.threadDeleted ||
            (event.type === ThreadEvents.threadUpdated && typeof record?.archivedAt === "string");
          const threadId = record?.id;
          if (!gone || typeof threadId !== "string") return;
          // An archived thread's later updates (a title) find nothing left to close.
          if (sessions.list(threadId).length === 0) return;
          void sessions.close({ threadId }).catch((error: unknown) =>
            context.log.warn("terminals of a thread not closed", {
              threadId,
              error: String(error),
            }),
          );
        }),
      );
    }

    const Empty = z.object({});
    context.commands.register({
      name: "terminals.open",
      title: "Open a terminal",
      description:
        "Starts a shell in cwd for a thread under a terminal id the caller chooses (T3's term-1, term-2…), or returns the one running under these ids. Its output streams on terminal/<threadId>/<terminalId>.",
      input: OpenTerminalInput,
      output: TerminalSummary,
      permissions: ["terminals.write"],
      handler: (input) => sessions.open(input),
    });
    context.commands.register({
      name: "terminals.write",
      title: "Type into a terminal",
      description: "Sends input to a running terminal, as typed (\\r for Enter).",
      input: WriteTerminalInput,
      output: Empty,
      permissions: ["terminals.write"],
      handler: (input) => {
        sessions.write(input);
        return {};
      },
    });
    context.commands.register({
      name: "terminals.resize",
      title: "Resize a terminal",
      description: "Sets a running terminal's size in columns and rows.",
      input: ResizeTerminalInput,
      output: Empty,
      permissions: ["terminals.write"],
      handler: (input) => {
        sessions.resize(input);
        return {};
      },
    });
    context.commands.register({
      name: "terminals.close",
      title: "Close a terminal",
      description:
        "Ends a terminal and its process, or every terminal of the thread without terminalId.",
      input: CloseTerminalInput,
      output: z.object({ closed: z.number().int() }),
      permissions: ["terminals.write"],
      handler: async (input) => ({ closed: await sessions.close(input) }),
    });
    context.commands.register({
      name: "terminals.list",
      title: "List terminals",
      description:
        "The terminals of this node, or of one thread. The terminals stream sends the list again after every change.",
      input: z.object({ threadId: TerminalThreadId.optional() }),
      output: z.object({ terminals: z.array(TerminalSummary) }),
      permissions: ["terminals.read"],
      handler: (input) => ({ terminals: [...sessions.list(input.threadId)] }),
    });
    context.commands.register({
      name: "terminals.get",
      title: "Read a terminal",
      description:
        "A terminal with the output it still keeps (its scrollback) and the sequence to follow its stream after.",
      input: z.object({ threadId: TerminalThreadId, terminalId: TerminalId }),
      output: TerminalSnapshot,
      permissions: ["terminals.read"],
      handler: (input) => {
        const found = sessions.get(input.threadId, input.terminalId);
        if (found === undefined) {
          throw new TerminalError(
            "TERMINAL_NOT_FOUND",
            `No terminal ${input.terminalId} in thread ${input.threadId}`,
            { ...input, instance: sessions.instance },
          );
        }
        return found;
      },
    });
  },
});
