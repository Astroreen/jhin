// The actions and their wording follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/hooks/useThreadActionMenu.ts, apps/web/src/components/threadActionMenu.logic.ts
// and apps/web/src/components/Sidebar.tsx.
import {
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  SIDEBAR_NOTICES_SLOT,
  THREAD_PARK_HOOK,
  UNDO_CAPABILITY,
  THREADS_CAPABILITY,
  VISITS_CAPABILITY,
  targetKey,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeTarget,
  type ProjectActionProps,
  type ThreadActionProps,
  type ThreadParkInput,
  type ThreadRecord,
  type ThreadSection,
  type ThreadUndoService,
  type ThreadsCatalog,
  type ThreadVisits,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  Alert,
  AlertDescription,
  InlineButton,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import {
  ArchiveIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  HashIcon,
  LinkIcon,
  MailOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TimerIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { builtin } from "../lib/builtin.ts";
import { CustomSnoozeDialogHost, createCustomSnoozeRequests } from "../lib/custom-snooze.tsx";
import { canSnooze, threadSection } from "../lib/sidebar-order.ts";
import { snoozePresets } from "../lib/snooze.ts";
import { useExternal } from "../lib/hooks.ts";
import { threadActions, type ThreadArrangement } from "../lib/thread-actions.ts";
import { createThreadUndo, undoNoticeText, type UndoAction } from "../lib/thread-undo.ts";

const At = { node: z.string(), remote: z.string().optional() };
const ThreadRef = z.object({ ...At, threadId: z.string() });
const ProjectRef = z.object({ ...At, projectId: z.string() });

const targetOf = (input: { node: string; remote?: string | undefined }): NodeTarget => ({
  node: input.node,
  ...(input.remote === undefined ? {} : { remote: input.remote }),
});

/** One item of an actions menu. */
function ActionItem(props: {
  icon: LucideIcon;
  label: string;
  onClick(): void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const Icon = props.icon;
  return (
    <MenuItem
      disabled={props.disabled === true}
      onClick={props.onClick}
      {...(props.destructive === true ? { variant: "destructive" as const } : {})}
    >
      <Icon />
      {props.label}
    </MenuItem>
  );
}

/**
 * What can be done to a thread or a project, as commands (so shortcuts, the
 * palette and other plugins reach them too), and the items of the
 * `thread.actions` and `project.actions` menus that run them. The sidebar and
 * the thread view only show those menus; plugins add their own items.
 */
/** A stable source when no keybindings plugin is active. */
const NO_KEYBINDINGS = { subscribe: () => ({ dispose() {} }) };

export const threadActionsPlugin = builtin(
  "jhin.thread-actions",
  {
    provides: { [UNDO_CAPABILITY]: "1.0.0" },
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
    },
    optional: {
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [VISITS_CAPABILITY]: "^1",
      [KEYBINDINGS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const visits = context.services.tryGet<ThreadVisits>(VISITS_CAPABILITY);
      const actions = threadActions({
        context,
        threads,
        navigation,
        mesh,
        toasts,
        dialogs,
        visits,
      });
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const undo = createThreadUndo({
        fail: (title, error) =>
          toasts?.show({ type: "error", title, description: (error as Error).message }),
      });
      context.subscriptions.add({ dispose: () => undo.dispose() });
      const undoService: ThreadUndoService = {
        async run({ kind, key, action, noun, failureTitle, perform, revert, voids = [] }) {
          const claim = undo.begin(kind, key);
          let done = false;
          try {
            done = await perform();
          } finally {
            if (done && claim.isCurrent()) {
              for (const other of voids) undo.invalidate(other, key);
              undo.show({
                action,
                noun,
                claim,
                failureTitle,
                undo: async () => void (await revert()),
              });
            } else claim.finish();
          }
          return done;
        },
        invalidate: (kind, key) => undo.invalidate(kind, key),
      };
      context.services.provide(UNDO_CAPABILITY, undoService);

      /** T3's SidebarThreadUndoNotice: what was just done, and how to take it back. */
      function UndoNoticeView() {
        const notice = useExternal(undo, undo.notice);
        const shortcut = useExternal(keybindings ?? NO_KEYBINDINGS, () =>
          keybindings?.labelFor("thread.undo"),
        );
        if (notice === undefined) return null;
        return (
          <Alert role="status" variant="sidebar">
            <AlertDescription>
              {undoNoticeText(notice)},{" "}
              <InlineButton onClick={() => undo.undoLatest()}>
                {shortcut === undefined ? "Undo" : `${shortcut} to undo`}
              </InlineButton>
            </AlertDescription>
          </Alert>
        );
      }
      context.subscriptions.add(
        slots.contribute(SIDEBAR_NOTICES_SLOT, {
          id: "jhin.thread-actions.undo-notice",
          component: UndoNoticeView,
        }),
      );
      context.commands.register({
        name: "thread.undo",
        title: "Undo",
        description:
          "Undoes the latest thread action the sidebar offers to undo (unpin, settle, snooze, archive), while its notice shows",
        input: z.object({}),
        output: z.object({ undone: z.boolean() }),
        handler: () => ({ undone: undo.undoLatest() }),
      });
      if (keybindings !== undefined)
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
          ]),
        );

      const threadOf = (input: z.infer<typeof ThreadRef>) => {
        const target = targetOf(input);
        const thread = threads.catalog(target).threads.find((item) => item.id === input.threadId);
        if (thread === undefined) {
          throw Object.assign(new Error(`No thread ${input.threadId} on this node`), {
            code: "THREAD_NOT_FOUND",
          });
        }
        return { target, thread };
      };
      const projectOf = (input: z.infer<typeof ProjectRef>) => {
        const target = targetOf(input);
        const catalog = threads.catalog(target);
        const project = catalog.projects.find((item) => item.id === input.projectId);
        if (project === undefined) {
          throw Object.assign(new Error(`No project ${input.projectId} on this node`), {
            code: "PROJECT_NOT_FOUND",
          });
        }
        return { target, project, catalog };
      };

      const register = <I extends z.ZodType>(
        name: string,
        title: string,
        description: string,
        input: I,
        run: (input: z.output<I>) => unknown,
      ) =>
        context.commands.register({
          name,
          title,
          description,
          input,
          output: z.object({}),
          handler: async (value) => {
            await run(value);
            return {};
          },
        });

      register(
        "thread.rename",
        "Rename thread",
        "Gives a thread another title",
        ThreadRef.extend({ title: z.string() }),
        async (input) => {
          const { target, thread } = threadOf(input);
          await actions.rename(target, thread, input.title);
        },
      );
      register(
        "thread.regenerate-title",
        "Regenerate title",
        "Has an agent write the thread a new title from its messages",
        ThreadRef,
        async (input) => {
          const { target, thread } = threadOf(input);
          await actions.regenerateTitle(target, thread);
        },
      );
      register(
        "thread.mark-unread",
        "Mark thread unread",
        "Shows the thread's latest turn as new again",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          actions.markUnread(target, thread);
        },
      );
      register("thread.copy-id", "Copy thread ID", "Copies a thread's id", ThreadRef, (input) =>
        actions.copyId(threadOf(input).thread),
      );
      register(
        "thread.copy-address",
        "Copy thread address",
        "Copies a thread's jhin:// address, which any node of the mesh resolves",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          actions.copyAddress(target, thread);
        },
      );
      register(
        "thread.archive",
        "Archive thread",
        "Hides a thread from the sidebar until it is unarchived",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          return undoable(
            input,
            "archive",
            "Archived",
            "Failed to undo archive",
            () => actions.archive(target, thread),
            () => threads.call(target, "threads.unarchive", { threadId: thread.id }),
          );
        },
      );
      register(
        "thread.unarchive",
        "Unarchive thread",
        "Brings an archived thread back",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          undo.invalidate("archive", undoKey(input));
          return actions.unarchive(target, thread);
        },
      );
      register(
        "thread.delete",
        "Delete thread",
        "Deletes a thread for good, after asking",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          return actions.remove(target, thread);
        },
      );
      // Where the sidebar keeps a thread (D75–D77): kept on its node.
      const customSnooze = createCustomSnoozeRequests();
      const undoKey = (input: z.infer<typeof ThreadRef>) =>
        `${targetKey(targetOf(input))}|${input.threadId}`;
      /** Runs an action and, once it succeeded, offers to undo it (T3's undo notice, D450). */
      const undoable = (
        input: z.infer<typeof ThreadRef>,
        kind: string,
        action: UndoAction,
        failureTitle: string,
        perform: () => Promise<boolean>,
        revert: () => Promise<unknown>,
        voids: readonly string[] = [],
      ): Promise<boolean> =>
        undoService.run({
          kind,
          key: undoKey(input),
          action,
          noun: "thread",
          failureTitle,
          perform,
          revert,
          voids,
        });
      const arrangeThread = (
        input: z.infer<typeof ThreadRef>,
        change: ThreadArrangement,
        failure: string,
      ) => {
        const { target, thread } = threadOf(input);
        return actions.arrange(target, thread, change, failure);
      };
      /** Settling and snoozing go through `thread.park`, so a host can move on from the thread. */
      const park = (
        input: z.infer<typeof ThreadRef>,
        action: ThreadParkInput["action"],
        perform: () => Promise<boolean>,
      ) =>
        context.hooks.run<ThreadParkInput, boolean>(
          THREAD_PARK_HOOK,
          { target: targetOf(input), threadId: input.threadId, action },
          perform,
        );
      register(
        "thread.settle",
        "Settle thread",
        "Moves a thread to the Settled shelf until it is un-settled or runs again",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          const wake = thread.snoozedUntil;
          return undoable(
            input,
            "settle",
            "Settled",
            "Failed to undo settle",
            () =>
              park(input, "settle", () =>
                arrangeThread(input, { method: "settle" }, "Failed to settle thread"),
              ),
            async () => {
              await threads.call(target, "threads.arrange", {
                steps: [
                  { op: "unsettle", threadId: thread.id },
                  ...(thread.pinnedAt === undefined
                    ? []
                    : [
                        {
                          op: "pin",
                          threadId: thread.id,
                          ...(thread.pinOrderKey === undefined
                            ? {}
                            : { orderKey: thread.pinOrderKey }),
                        },
                      ]),
                ],
              });
              if (wake !== undefined && Date.parse(wake) > Date.now())
                await threads.call(target, "threads.snooze", { threadId: thread.id, until: wake });
            },
            // Settling unpins and wakes: once it did, their own undos are void; this one restores both.
            ["pin", "snooze"],
          );
        },
      );
      register(
        "thread.set-auto-settle",
        "Set auto-settle behavior",
        "Lets a thread settle by itself (its node's rule: no activity for the configured days, or its pull request merged or closed), or never",
        ThreadRef.extend({ enabled: z.boolean() }),
        (input) =>
          arrangeThread(
            input,
            { method: "set-auto-settle", enabled: input.enabled },
            "Failed to update auto-settle",
          ),
      );
      register(
        "thread.unsettle",
        "Un-settle thread",
        "Brings a thread back from the Settled shelf to the top of the active threads",
        ThreadRef,
        (input) => {
          undo.invalidate("settle", undoKey(input));
          return arrangeThread(input, { method: "unsettle" }, "Failed to un-settle thread");
        },
      );
      register(
        "thread.pin",
        "Pin thread",
        "Pins a thread above the active ones",
        ThreadRef,
        (input) => {
          undo.invalidate("pin", undoKey(input));
          return arrangeThread(input, { method: "pin" }, "Failed to pin thread");
        },
      );
      register(
        "thread.unpin",
        "Unpin thread",
        "Unpins a thread, after asking when the settings say so",
        ThreadRef,
        (input) => {
          const { target, thread } = threadOf(input);
          const orderKey = thread.pinOrderKey;
          return undoable(
            input,
            "pin",
            "Unpinned",
            "Failed to undo unpin",
            () => actions.unpin(target, thread),
            () =>
              threads.call(target, "threads.pin", {
                threadId: thread.id,
                ...(orderKey === undefined ? {} : { orderKey }),
              }),
          );
        },
      );
      register(
        "thread.snooze",
        "Snooze thread",
        "Hides a thread until `until`, or a time asked for in the custom snooze dialog; it wakes earlier when it asks for something, fails or completes",
        ThreadRef.extend({ until: z.iso.datetime({ offset: true }).optional() }),
        async (input) => {
          threadOf(input);
          const until = input.until ?? (await customSnooze.request());
          if (until === undefined) return;
          const { target, thread } = threadOf(input);
          await undoable(
            input,
            "snooze",
            "Snoozed",
            "Failed to wake thread",
            () =>
              park(input, "snooze", () =>
                arrangeThread(input, { method: "snooze", until }, "Failed to snooze thread"),
              ),
            () => threads.call(target, "threads.unsnooze", { threadId: thread.id }),
          );
        },
      );
      // T3's "Custom snooze" dialog on its own, for whoever snoozes (t3-parity.md D962).
      context.commands.register({
        name: "thread.snooze.choose",
        title: "Choose a snooze time",
        description:
          "Asks for a wake time in the custom snooze dialog; answers nothing when it is cancelled",
        input: z.object({}),
        output: z.object({ until: z.iso.datetime({ offset: true }).optional() }),
        handler: async () => {
          const until = await customSnooze.request();
          return until === undefined ? {} : { until };
        },
      });
      register(
        "thread.unsnooze",
        "Wake thread",
        "Wakes a snoozed thread now",
        ThreadRef,
        (input) => {
          undo.invalidate("snooze", undoKey(input));
          return arrangeThread(input, { method: "unsnooze" }, "Failed to wake thread");
        },
      );
      context.subscriptions.add(
        slots.contribute("app.global", {
          id: "jhin.thread-actions.custom-snooze",
          component: () => <CustomSnoozeDialogHost requests={customSnooze} />,
        }),
      );

      register(
        "project.new-thread",
        "New thread in project",
        "Opens a new thread in a project",
        ProjectRef,
        (input) => {
          const { target, project } = projectOf(input);
          navigation.navigate({ ...target, project: project.id });
        },
      );
      register(
        "project.rename",
        "Rename project",
        "Gives a project another name, after asking for it",
        ProjectRef,
        (input) => {
          const { target, project } = projectOf(input);
          return actions.renameProject(target, project);
        },
      );
      register(
        "project.copy-path",
        "Copy project path",
        "Copies a project's folder on its node",
        ProjectRef,
        (input) => actions.copyPath(projectOf(input).project),
      );
      register(
        "project.remove",
        "Remove project",
        "Removes a project and deletes its threads, after asking; its folder stays",
        ProjectRef,
        (input) => {
          const { target, project, catalog } = projectOf(input);
          const count = catalog.threads.filter((thread) => thread.projectId === project.id).length;
          return actions.removeProject(target, project, count);
        },
      );

      /** Runs a command for a menu item; what fails shows as a toast. */
      const run = (name: string, input: unknown) =>
        void context.commands.execute(name, input).catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Could not do that",
            description: (error as Error).message,
          }),
        );
      const threadRef = (target: NodeTarget, threadId: string) => ({ ...target, threadId });
      /** Where the menu's host lists the thread, else where the sidebar would now. */
      const sectionOf = (thread: ThreadRecord, section: ThreadSection | undefined) =>
        section ?? threadSection(thread, Date.now());

      /** T3's "Snooze" submenu: its presets and "Custom…"; "Wake thread" for a snoozed thread. */
      function SnoozeItem({ target, thread, section }: ThreadActionProps) {
        if (sectionOf(thread, section) === "snoozed") {
          return (
            <ActionItem
              icon={ClockIcon}
              label="Wake thread"
              onClick={() => run("thread.unsnooze", threadRef(target, thread.id))}
            />
          );
        }
        const disabled = !canSnooze(thread);
        return (
          <MenuSub>
            <MenuSubTrigger disabled={disabled}>
              <ClockIcon />
              Snooze
            </MenuSubTrigger>
            <MenuSubPopup>
              {snoozePresets(new Date()).map((preset) => (
                <MenuItem
                  key={preset.id}
                  onClick={() =>
                    run("thread.snooze", {
                      ...threadRef(target, thread.id),
                      until: preset.snoozedUntil,
                    })
                  }
                >
                  {preset.label}
                  <MenuShortcut>{preset.whenLabel}</MenuShortcut>
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={() => run("thread.snooze", threadRef(target, thread.id))}>
                Custom…
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        );
      }
      /** T3's "Auto-settle behavior" submenu: whether the node may settle the thread by itself. */
      function AutoSettleItem({ target, thread }: ThreadActionProps) {
        const enabled = thread.autoSettleDisabledAt === undefined;
        return (
          <MenuSub>
            <MenuSubTrigger>
              <TimerIcon />
              Auto-settle behavior
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                onValueChange={(next: unknown) => {
                  if (next !== "enabled" && next !== "disabled") return;
                  if ((next === "enabled") === enabled) return;
                  run("thread.set-auto-settle", {
                    ...threadRef(target, thread.id),
                    enabled: next === "enabled",
                  });
                }}
                value={enabled ? "enabled" : "disabled"}
              >
                <MenuRadioItem value="enabled">Enabled</MenuRadioItem>
                <MenuRadioItem value="disabled">Disabled</MenuRadioItem>
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        );
      }
      const projectRef = (target: NodeTarget, projectId: string) => ({ ...target, projectId });

      const threadItems: [string, number, ComponentType<ThreadActionProps>][] = [
        [
          "new-in-project",
          0,
          ({ target, project }) =>
            project === undefined ? null : (
              <ActionItem
                icon={SquarePenIcon}
                label={`New thread in ${project.name}`}
                onClick={() => run("project.new-thread", projectRef(target, project.id))}
              />
            ),
        ],
        [
          "pin",
          2,
          ({ target, thread }) =>
            thread.pinnedAt === undefined ? (
              <ActionItem
                icon={PinIcon}
                label="Pin thread"
                onClick={() => run("thread.pin", threadRef(target, thread.id))}
              />
            ) : (
              <ActionItem
                icon={PinOffIcon}
                label="Unpin thread"
                onClick={() => run("thread.unpin", threadRef(target, thread.id))}
              />
            ),
        ],
        [
          "settle",
          3,
          ({ target, thread, section }) =>
            sectionOf(thread, section) === "settled" ? (
              <ActionItem
                icon={CircleCheckIcon}
                label="Un-settle thread"
                onClick={() => run("thread.unsettle", threadRef(target, thread.id))}
              />
            ) : (
              <ActionItem
                icon={CircleCheckIcon}
                label="Settle thread"
                onClick={() => run("thread.settle", threadRef(target, thread.id))}
              />
            ),
        ],
        ["snooze", 4, SnoozeItem],
        ["separator-arrange", 5, () => <MenuSeparator />],
        [
          "rename",
          10,
          ({ rename }) =>
            rename === undefined ? null : (
              <ActionItem icon={PencilIcon} label="Rename thread" onClick={rename} />
            ),
        ],
        [
          "regenerate-title",
          15,
          ({ target, thread }) => {
            const busy = thread.titleRegeneration !== undefined;
            return (
              <ActionItem
                disabled={busy}
                icon={RefreshCwIcon}
                label={busy ? "Regenerating…" : "Regenerate title"}
                onClick={() => run("thread.regenerate-title", threadRef(target, thread.id))}
              />
            );
          },
        ],
        [
          "mark-unread",
          20,
          ({ target, thread }) => (
            <ActionItem
              icon={MailOpenIcon}
              label="Mark unread"
              onClick={() => run("thread.mark-unread", threadRef(target, thread.id))}
            />
          ),
        ],
        // T3 puts it before the copy items.
        ["auto-settle", 25, AutoSettleItem],
        [
          "copy-id",
          30,
          ({ target, thread }) => (
            <ActionItem
              icon={HashIcon}
              label="Copy thread ID"
              onClick={() => run("thread.copy-id", threadRef(target, thread.id))}
            />
          ),
        ],
        [
          "copy-address",
          40,
          ({ target, thread }) => (
            <ActionItem
              icon={LinkIcon}
              label="Copy thread address"
              onClick={() => run("thread.copy-address", threadRef(target, thread.id))}
            />
          ),
        ],
        ["separator", 50, () => <MenuSeparator />],
        [
          "archive",
          60,
          ({ target, thread }) => (
            <ActionItem
              // A running turn is stopped by archiving: not from a menu item in passing.
              disabled={
                thread.lastTurn?.status === "running" || thread.lastTurn?.status === "waiting"
              }
              icon={ArchiveIcon}
              label="Archive thread"
              onClick={() => run("thread.archive", threadRef(target, thread.id))}
            />
          ),
        ],
        [
          "delete",
          70,
          ({ target, thread }) => (
            <ActionItem
              destructive
              icon={Trash2Icon}
              label="Delete"
              onClick={() => run("thread.delete", threadRef(target, thread.id))}
            />
          ),
        ],
      ];
      for (const [id, order, component] of threadItems) {
        context.subscriptions.add(
          slots.contribute("thread.actions", {
            id: `jhin.thread-actions.${id}`,
            order,
            component,
          }),
        );
      }

      // The scratch project is neither renamed nor removed.
      const projectItems: [string, number, ComponentType<ProjectActionProps>][] = [
        [
          "new-thread",
          0,
          ({ target, project }) => (
            <ActionItem
              icon={SquarePenIcon}
              label="New thread"
              onClick={() => run("project.new-thread", projectRef(target, project.id))}
            />
          ),
        ],
        [
          "rename",
          10,
          ({ target, project }) =>
            project.scratch ? null : (
              <ActionItem
                icon={PencilIcon}
                label="Rename project"
                onClick={() => run("project.rename", projectRef(target, project.id))}
              />
            ),
        ],
        [
          "copy-path",
          20,
          ({ target, project }) => (
            <ActionItem
              icon={CopyIcon}
              label="Copy path"
              onClick={() => run("project.copy-path", projectRef(target, project.id))}
            />
          ),
        ],
        ["separator", 30, ({ project }) => (project.scratch ? null : <MenuSeparator />)],
        [
          "remove",
          40,
          ({ target, project }) =>
            project.scratch ? null : (
              <ActionItem
                destructive
                icon={Trash2Icon}
                label="Remove project"
                onClick={() => run("project.remove", projectRef(target, project.id))}
              />
            ),
        ],
      ];
      for (const [id, order, component] of projectItems) {
        context.subscriptions.add(
          slots.contribute("project.actions", {
            id: `jhin.thread-actions.project.${id}`,
            order,
            component,
          }),
        );
      }
    },
  }),
);
