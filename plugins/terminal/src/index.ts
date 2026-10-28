import * as Path from "node:path";

import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { MESH_STREAMS_CAPABILITY, type MeshStreams } from "@jhin/mesh-api";
import { LIVE_STREAMS_CAPABILITY, createMemoryStreams, type LiveStreams } from "@jhin/rpc";
import { definePlugin, z, describePermissions } from "@jhin/sdk";
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
    history: z.boolean().default(true).meta({
      title: "Keep history across restarts",
      description:
        "Writes each terminal's output to the node's data folder (owner-only, unencrypted) so it shows again after a restart. Read when the plugin starts.",
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
    // Output kept across node restarts (D464), where the node has a data folder.
    const history =
      paths === undefined || !context.config.get<Config>(CONFIG_SECTION).history
        ? undefined
        : createHistoryFiles(Path.join(paths.dataDir(context.plugin.id), "history"), context.log);
    const sessions = createSessions({
      streams,
      pty: loadNodePty,
      processTable: createProcessTableReader(),
      config: () => context.config.get<Config>(CONFIG_SECTION),
      log: context.log,
      ...(history === undefined ? {} : { history }),
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
      // D501: members relay them to their clients, so a thread on this node has its
      // terminals wherever it is opened (a member's call holds every permission).
      const mesh = context.services.tryGet<MeshStreams>(MESH_STREAMS_CAPABILITY);
      if (mesh !== undefined) {
        context.subscriptions.add(mesh.share(TERMINALS_STREAM));
        context.subscriptions.add(mesh.share(TERMINAL_STREAM_PREFIX));
      }
    }

    // A deleted or archived thread takes its terminals with it (D143, D466).
    if (log !== undefined) {
      /** Threads seen archived: their later updates (a title) leave terminals alone. */
      const archived = new Set<string>();
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          const record = event.payload as { id?: unknown; archivedAt?: unknown } | null;
          const threadId = record?.id;
          if (typeof threadId !== "string") return;
          if (event.type === ThreadEvents.threadUpdated) {
            if (typeof record?.archivedAt !== "string") {
              archived.delete(threadId);
              return;
            }
            // Closed on the change to archived only.
            if (archived.has(threadId)) return;
            archived.add(threadId);
          } else if (event.type === ThreadEvents.threadDeleted) {
            archived.delete(threadId);
          } else return;
          void sessions
            .close({ threadId })
            // Files of terminals not open since the node started go too.
            .then(() => history?.deleteThread(threadId))
            .catch((error: unknown) =>
              context.log.warn("terminals of a thread not closed", {
                threadId,
                error: String(error),
              }),
            );
        }),
      );
    }

    const Empty = z.object({});
    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "terminals.read": {
        title: "View terminals",
        description: "Read existing terminal output and status.",
      },
      "terminals.write": {
        title: "Use terminals",
        description: "Create terminals and send input to running shells.",
        shellAccess: true,
      },
    });
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
      name: "terminals.close-idle",
      title: "Close idle terminals",
      description:
        "Closes a thread's terminals (or one) that run no command under their shell, read now, and printed and were typed nothing meanwhile (T3's closeIdle).",
      input: z.object({ threadId: TerminalThreadId, terminalId: TerminalId.optional() }),
      output: z.object({ closed: z.number().int() }),
      permissions: ["terminals.write"],
      handler: async (input) => ({
        closed: await sessions.closeIdle(input.threadId, input.terminalId),
      }),
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
