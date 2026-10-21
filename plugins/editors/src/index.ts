// Opening a file follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): `shell.openInEditor` and the
// server config's `availableEditors` (apps/server/src/process/externalLauncher.ts).
import * as ChildProcess from "node:child_process";

import { EDITORS, HOST_EDITORS_CAPABILITY, type EditorErrorCode } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";

import * as Path from "node:path";

import {
  cmdLaunch,
  editorArgs,
  fileManagerCommand,
  needsCmd,
  findEditorCommand,
  nodeHost,
  resolveInProject,
  type Host,
  type Launch,
} from "./editors.ts";

export class EditorError extends Error {
  readonly code: EditorErrorCode;
  constructor(code: EditorErrorCode, message: string) {
    super(message);
    this.name = "EditorError";
    this.code = code;
  }
}

/** What the plugin runs on: the real host and process launcher, or a test's. */
export interface EditorsEnvironment {
  readonly host: Host;
  launch(launch: Launch): Promise<void>;
}

/** Starts a program detached from the node, so closing the node leaves the editor open. */
export function launchDetached(launch: Launch): Promise<void> {
  return new Promise((resolve, reject) => {
    // A node run by an Electron shell passes this on; editors started from it would run as Node.
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
    const child = ChildProcess.spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      env,
      // A `.cmd`/`.bat` launcher comes as a quoted `cmd.exe` line (cmdLaunch); Node adds no quotes.
      windowsVerbatimArguments: launch.verbatim === true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const EditorInfo = z.object({ id: z.string(), label: z.string() });
const Projects = z.array(z.object({ id: z.string(), path: z.string() }));

/** The editors, by T3's order, that the host can start; the file manager last. */
export function availableEditors(host: Host) {
  return EDITORS.filter((editor) =>
    editor.id === "file-manager"
      ? fileManagerCommand(host) !== undefined
      : findEditorCommand(editor, host) !== undefined,
  ).map((editor) => ({ id: editor.id, label: editor.label }));
}

export function createEditorsPlugin(
  environment: EditorsEnvironment = { host: nodeHost, launch: launchDetached },
) {
  return definePlugin({
    activate(context) {
      const { host } = environment;
      context.services.provide(HOST_EDITORS_CAPABILITY, {
        list: () => availableEditors(host),
      });

      context.commands.register({
        name: "editors.list",
        description: "The editors installed on this node that can open a project's files",
        input: z.object({}),
        output: z.object({ editors: z.array(EditorInfo) }),
        permissions: ["editor.list"],
        handler: () => ({ editors: availableEditors(host) }),
      });

      context.commands.register({
        name: "editors.open",
        description:
          "Opens a file of a project in an editor installed on this node (or with the file manager), optionally at a line",
        input: z.object({
          projectId: z.string().min(1),
          path: z
            .string()
            .min(1)
            .meta({ description: "The file, relative to the project's folder" }),
          line: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
          editor: z.string().min(1).meta({ description: "An id from editors.list" }),
        }),
        output: z.object({ editor: z.string(), path: z.string() }),
        permissions: ["editor.open"],
        handler: async (input) => {
          // No capability describes projects: they are read with `projects.list`, as
          // source control reads them (D111); without a projects plugin there are none.
          const listed = await context.commands
            .execute("projects.list", {})
            .catch((error: unknown) => {
              if ((error as { code?: unknown }).code === "COMMAND_NOT_FOUND") return [];
              throw error;
            });
          const projects = Projects.safeParse(listed);
          const project = (projects.success ? projects.data : []).find(
            (candidate) => candidate.id === input.projectId,
          );
          if (project === undefined) {
            throw new EditorError(
              "PROJECT_NOT_FOUND",
              `No project ${input.projectId} on this node`,
            );
          }
          const path = resolveInProject(project.path, input.path);
          if (path === undefined) {
            throw new EditorError(
              "PATH_OUTSIDE_PROJECT",
              `${input.path} is not a file of the project`,
            );
          }
          const editor = EDITORS.find((candidate) => candidate.id === input.editor);
          let launch: Launch | undefined;
          if (editor?.id === "file-manager") {
            const command = fileManagerCommand(host);
            // The containing folder, never the file: a file manager runs whatever a file is
            // (a script, a `.desktop` entry), and the project's files are not all the user's.
            if (command !== undefined) launch = { command, args: [Path.dirname(path)] };
          } else if (editor !== undefined) {
            const found = findEditorCommand(editor, host);
            if (found !== undefined) {
              launch = {
                command: found.command,
                args: [
                  ...found.baseArgs,
                  ...editorArgs(editor, {
                    path,
                    ...(input.line === undefined ? {} : { line: input.line }),
                    ...(input.column === undefined ? {} : { column: input.column }),
                  }),
                ],
              };
            }
          }
          if (launch !== undefined && needsCmd(host.platform, launch.command)) {
            const throughCmd = cmdLaunch(launch.command, launch.args);
            if (throughCmd === undefined) {
              throw new EditorError(
                "PATH_UNSAFE",
                `${input.path} holds characters a Windows launcher cannot pass safely`,
              );
            }
            launch = throughCmd;
          }
          if (launch === undefined) {
            throw new EditorError(
              "EDITOR_NOT_FOUND",
              `${editor?.label ?? input.editor} is not installed on this node`,
            );
          }
          try {
            await environment.launch(launch);
          } catch (error) {
            throw new EditorError(
              "LAUNCH_FAILED",
              `Could not start ${launch.command}: ${(error as Error).message}`,
            );
          }
          context.log.info("opened in editor", { editor: input.editor, path });
          return { editor: input.editor, path };
        },
      });
    },
  });
}

export default createEditorsPlugin();
