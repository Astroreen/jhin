// Running a project's scripts follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/ChatView.tsx (runProjectScript, lastInvokedScriptByProjectId)
// and apps/web/src/projectScripts.ts (the `script.<id>.run` commands).
import {
  commandForProjectScript,
  type ProjectScript,
  type T3ProjectFileScript,
} from "@jhin/agent-api";
import {
  KEYBINDINGS_CAPABILITY,
  KEYBINDINGS_CONFIG_SECTION,
  KeybindingsConfig,
  NAVIGATION_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatHeaderActionProps,
  type DeviceSettings,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z, type Disposable } from "@jhin/sdk";
import {
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { useExternal } from "../../lib/hooks.ts";
import { readSection } from "../../lib/settings.ts";
import { ProjectScriptsControl, type ScriptsControlServices } from "./control.tsx";

/** The script last run in each project on this device (T3's `lastInvokedScriptByProjectId`). */
const LAST_RUN_KEY = "jhin:project-scripts:last-run";

function readLastRun(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_RUN_KEY) ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const projectKey = (target: NodeTarget, projectId: string) =>
  `${target.node}/${target.remote ?? ""}/${projectId}`;

/**
 * T3's scripts menu in the chat header (`source-control.md` D1473–D1475):
 * runs, adds, edits and imports a project's scripts, and runs one by its
 * shortcut (`script.<id>.run`).
 */
export const projectScriptsPlugin = builtin(
  "jhin.project-scripts",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [SETTINGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const settings = context.services.tryGet<DeviceSettings>(SETTINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      let lastRun = readLastRun();

      /** T3's `runProjectScript`: the node types it; its terminal shows; its preview opens. */
      const run = async (target: NodeTarget, thread: ThreadRecord, script: ProjectScript) => {
        lastRun = { ...lastRun, [projectKey(target, thread.projectId)]: script.id };
        try {
          localStorage.setItem(LAST_RUN_KEY, JSON.stringify(lastRun));
        } catch {
          // Not kept on this device: the header falls back to the project's first script.
        }
        try {
          const { terminalId } = await threads.call<{ terminalId: string }>(target, "scripts.run", {
            threadId: thread.id,
            scriptId: script.id,
          });
          await context.commands
            .execute("terminal.reveal", { ...target, threadId: thread.id, terminalId })
            .catch(() => undefined);
          if (script.autoOpenPreview === true && script.previewUrl !== undefined) {
            const names = new Set(context.commands.list().map((command) => command.name));
            if (names.has("preview.open-url")) {
              await context.commands.execute("preview.open-url", { url: script.previewUrl });
            }
          }
        } catch (error) {
          toasts?.show({
            type: "error",
            title: `Failed to run script "${script.name}".`,
            description: (error as Error).message,
          });
        }
      };

      const customRules = () =>
        readSection(context, KEYBINDINGS_CONFIG_SECTION, KeybindingsConfig).rules;
      const services: ScriptsControlServices = {
        run: (target, thread, script) => void run(target, thread, script),
        save: async (target, projectId, scripts) => {
          await threads.call(target, "projects.scripts.set", { projectId, scripts });
        },
        fileScripts: async (target, projectId, threadId) => {
          const answer = await threads.call<{ file: { scripts?: T3ProjectFileScript[] } | null }>(
            target,
            "projects.t3-file.get",
            { projectId, ...(threadId === undefined ? {} : { threadId }) },
          );
          return answer.file?.scripts ?? [];
        },
        lastRun: (target, projectId) => lastRun[projectKey(target, projectId)],
        shortcutLabel: (command) => keybindings?.labelFor(command),
        shortcutKey: (command) =>
          keybindings?.list().findLast((rule) => rule.command === command)?.key ?? null,
        // This device's rule, as Settings → Keybindings records one (D1475).
        setShortcut: async (command, key) => {
          if (settings === undefined) return;
          settings.patch(KEYBINDINGS_CONFIG_SECTION, {
            rules: [
              ...customRules().filter((rule) => rule.command !== command),
              ...(key === null ? [] : [{ key, command }]),
            ],
          });
        },
        confirmDelete: async (name) =>
          dialogs === undefined
            ? true
            : dialogs.confirm({
                title: `Delete action "${name}"?`,
                description: "This action cannot be undone.",
                confirmLabel: "Delete action",
                variant: "destructive",
              }),
      };

      /** Shown again when a shortcut changes, so the menu's labels are current. */
      const NO_KEYBINDINGS = { subscribe: () => toDisposable(() => undefined) };
      const NONE: readonly unknown[] = [];
      function ScriptsControl({ target, thread, project }: ChatHeaderActionProps) {
        useExternal(keybindings ?? NO_KEYBINDINGS, () => keybindings?.list() ?? NONE);
        if (project === undefined || project.scratch) return null;
        return (
          <ProjectScriptsControl
            project={project}
            services={services}
            target={target}
            thread={thread}
          />
        );
      }
      // T3's order: the scripts before the git actions.
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.project-scripts.control",
          order: -110,
          component: ScriptsControl,
        }),
      );

      // T3's `script.<id>.run`: each script of the open thread's project, by its shortcut.
      const registered = new Map<string, Disposable>();
      const target = (): { target: NodeTarget; thread: string } | undefined => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined) return undefined;
        return {
          target: {
            node: route.node,
            ...(route.remote === undefined ? {} : { remote: route.remote }),
          },
          thread: route.thread,
        };
      };
      const openThread = () => {
        const at = target();
        if (at === undefined) return undefined;
        const catalog = threads.catalog(at.target);
        const thread = catalog.threads.find((entry) => entry.id === at.thread);
        const project = catalog.projects.find((entry) => entry.id === thread?.projectId);
        return thread === undefined || project === undefined
          ? undefined
          : { target: at.target, thread, project };
      };
      let followed: Disposable | undefined;
      let followedKey = "";
      const sync = () => {
        const open = openThread();
        const key = open === undefined ? "" : `${open.target.node}/${open.target.remote ?? ""}`;
        if (key !== followedKey) {
          followed?.dispose();
          followedKey = key;
          followed = open === undefined ? undefined : threads.subscribe(open.target, sync);
        }
        const ids = new Set(
          ((open?.project.scripts ?? []) as readonly ProjectScript[]).flatMap((script) => {
            const command = commandForProjectScript(script.id);
            return command === undefined ? [] : [script.id];
          }),
        );
        for (const [id, registration] of registered) {
          if (ids.has(id)) continue;
          registration.dispose();
          registered.delete(id);
        }
        for (const id of ids) {
          if (registered.has(id)) continue;
          registered.set(
            id,
            context.commands.register({
              name: `script.${id}.run`,
              title: `Run script ${id}`,
              description:
                "Runs the open thread's project script with this id in its terminal (T3's script.<id>.run)",
              input: z.object({}),
              output: z.object({}),
              handler: async () => {
                const now = openThread();
                const script = ((now?.project.scripts ?? []) as readonly ProjectScript[]).find(
                  (entry) => entry.id === id,
                );
                if (now !== undefined && script !== undefined) {
                  await run(now.target, now.thread, script);
                }
                return {};
              },
            }),
          );
        }
      };
      context.subscriptions.add(navigation.subscribe(sync));
      context.subscriptions.add(
        toDisposable(() => {
          followed?.dispose();
          for (const registration of registered.values()) registration.dispose();
          registered.clear();
        }),
      );
      sync();
    },
  }),
);
