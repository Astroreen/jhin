// The diff toggle follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/PanelLayoutControls.tsx (the header's panel toggles) and
// ChatView.tsx (`diff.toggle`, bound to mod+d outside a terminal).
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREAD_DETAILS_SLOT,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatComposerContextProps,
  type ChatHeaderActionProps,
  type ChatTurnFooterProps,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type ThreadActionProps,
  type ThreadIndicatorProps,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { EditorInfo } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { DIFF_SCOPES_CAPABILITY } from "@jhin/source-control-api";
import {
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { FileDiffIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { CHAT_SECTION, ChatSettings, readSection } from "../../lib/settings.ts";
import { useExternal } from "../../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { DIFF_SECTION, DiffSettings } from "../../lib/settings.ts";
import { createRunningActions } from "./running.ts";
import { createChangedFilesFooter } from "./checkpoints.tsx";
import { createEditors, pathInside, preferredEditor } from "./diff/editors.tsx";
import { createDiffScopes, createDiffSelections, gitScopeProvider } from "./diff/scopes.ts";
import { turnScopeProvider } from "./diff/turns.ts";
import {
  createDraftWorkspaces,
  createWorktreeIndicator,
  registerWorkspaceHook,
  registerWorktreeCleanup,
} from "./workspace.tsx";
import { createCardIndicators } from "./indicators.tsx";
import { createLinkActions } from "./links.tsx";
import { DIFF_PANEL, useSourceControl, type SourceControlServices } from "./services.ts";
import { createSourceControlStore } from "./store.ts";

/**
 * Source control in the web client (docs/plans/source-control.md): the thread
 * cards' branch, pull request and diff (`sidebar.thread.indicators`), the
 * branch toolbar under the composer (`chat.composer.context`), the git
 * actions in the chat header, and the diff panel (`app.panel`) with its
 * toggle in the chat header and its scopes (`source-control.diff-scopes@1`).
 */
export const sourceControlPlugin = builtin(
  "jhin.source-control",
  {
    provides: { [DIFF_SCOPES_CAPABILITY]: "1.1.0" },
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [SETTINGS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const settings = context.services.tryGet<DeviceSettings>(SETTINGS_CAPABILITY);
      context.config.define(DIFF_SECTION, DiffSettings);
      const scopes = createDiffScopes();
      context.services.provide(DIFF_SCOPES_CAPABILITY, scopes);
      context.subscriptions.add(scopes.register(gitScopeProvider(threads)));
      const store = context.subscriptions.add(
        createSourceControlStore(connections, threads, context.log),
      );
      const services: SourceControlServices = {
        context,
        store,
        threads,
        connections,
        navigation,
        running: createRunningActions(),
        toasts,
        scopes,
        selections: createDiffSelections(),
        editors: createEditors(threads, toasts),
        settings,
        timestampFormat: () => readSection(context, CHAT_SECTION, ChatSettings).timestampFormat,
        shortcut: () => keybindings?.labelFor("diff.toggle"),
      };
      context.subscriptions.add(scopes.register(turnScopeProvider(services)));

      /** Opens or closes the diff panel of the thread (or draft) on screen. */
      const toggle = () => {
        const route = navigation.current();
        if (
          route.node === undefined ||
          (route.thread === undefined && route.project === undefined)
        ) {
          return false;
        }
        const { panel, section: _section, ...rest } = route;
        navigation.navigate(panel === DIFF_PANEL ? rest : { ...rest, panel: DIFF_PANEL });
        return true;
      };

      function DiffToggle({ target, thread, project }: ChatHeaderActionProps) {
        const route = useExternal(navigation, navigation.current);
        const view = useSourceControl(store, target);
        const projectId = project?.id ?? thread?.projectId;
        const status = projectId === undefined ? undefined : view.projects.get(projectId);
        if (status === undefined || !status.isRepo) return null;
        const open = route.panel === DIFF_PANEL;
        const shortcut = services.shortcut();
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                aria-label="Toggle diff panel"
                className="shrink-0"
                onPressedChange={() => toggle()}
                pressed={open}
                size="sm"
                variant="ghost"
              >
                <FileDiffIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {`Toggle diff panel${shortcut ? ` (${shortcut})` : ""}`}
            </TooltipPopup>
          </Tooltip>
        );
      }

      context.commands.register({
        name: "diff.toggle",
        title: "Toggle diff panel",
        description: "Shows or hides the diff of the thread on screen",
        input: z.object({}),
        output: z.object({ toggled: z.boolean() }),
        handler: () => ({ toggled: toggle() }),
      });
      // T3's openInPreferredEditor, for a path found in terminal output (terminal.md D965).
      context.commands.register({
        name: "files.open-in-editor",
        title: "Open in editor",
        description:
          "Opens a file of a thread's project, by its absolute path on the node, in the editor last chosen on this device",
        input: z.object({
          node: z.string(),
          remote: z.string().optional(),
          threadId: z.string(),
          path: z.string().min(1),
          line: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
        }),
        output: z.object({}),
        handler: async ({ threadId, path, line, column, ...input }) => {
          const target: NodeTarget = {
            node: input.node,
            ...(input.remote === undefined ? {} : { remote: input.remote }),
          };
          const catalog = threads.catalog(target);
          const thread = catalog.threads.find((item) => item.id === threadId);
          const project = catalog.projects.find((item) => item.id === thread?.projectId);
          // `editors.open` opens a project folder's files only (terminal.md#deferred).
          if (thread?.worktreePath !== undefined && pathInside(thread.worktreePath, path)) {
            throw new Error(`${path} is in the thread's worktree, whose files do not open yet`);
          }
          const relative = project === undefined ? undefined : pathInside(project.path, path);
          if (project === undefined || relative === undefined) {
            throw new Error(`${path} is not a file of the thread's project`);
          }
          const { editors } = await threads.call<{ editors: EditorInfo[] }>(
            target,
            "editors.list",
            {},
          );
          const editor = preferredEditor(editors);
          if (editor === undefined) throw new Error("No editor is installed on this node");
          // Its failure goes to the caller (the terminal writes it), not to a toast.
          await threads.call(target, "editors.open", {
            projectId: project.id,
            path: relative,
            editor: editor.id,
            ...(line === undefined ? {} : { line }),
            ...(column === undefined ? {} : { column }),
          });
          return {};
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
          ]),
        );
      }

      const { Branch, PullRequestIndicator, DiffCount, BranchDetail, BranchMismatch } =
        createCardIndicators(services);
      // The hover card: the branch, and T3's warning when another one is checked out.
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>(THREAD_DETAILS_SLOT, {
          id: "jhin.source-control.branch-detail",
          order: 0,
          component: BranchDetail,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>(THREAD_DETAILS_SLOT, {
          id: "jhin.source-control.branch-mismatch",
          order: 10,
          component: BranchMismatch,
        }),
      );
      // Worktrees (D253–D255): a draft's workspace, the card's icon, cleaning up on delete.
      const drafts = createDraftWorkspaces();
      context.subscriptions.add(registerWorkspaceHook(context, drafts));
      // T3's composer.workspace (D906): mod+shift+x opens a draft's workspace menu.
      context.commands.register({
        name: "composer.workspace",
        title: "Choose workspace",
        description:
          "Opens the workspace menu under the composer of a draft: current checkout, new worktree or previous worktree; `opened` is false when no draft is shown",
        input: z.object({}),
        output: z.object({ opened: z.boolean() }),
        handler: () => ({ opened: drafts.openMenu() }),
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
          ]),
        );
      }
      context.subscriptions.add(registerWorktreeCleanup(context, threads, dialogs, toasts));
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>("sidebar.thread.indicators", {
          id: "jhin.source-control.worktree",
          order: -50,
          component: createWorktreeIndicator(services),
        }),
      );
      // T3's order on the card: branch, (a terminal), pull request, diff.
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>("sidebar.thread.indicators", {
          id: "jhin.source-control.branch",
          order: -100,
          component: Branch,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>("sidebar.thread.indicators", {
          id: "jhin.source-control.pull-request",
          order: 100,
          component: PullRequestIndicator,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>("sidebar.thread.indicators", {
          id: "jhin.source-control.diff",
          order: 200,
          component: DiffCount,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ChatComposerContextProps>("chat.composer.context", {
          id: "jhin.source-control.branch-toolbar",
          // Its pickers and the workspace menu load with it, not with the page (D440).
          component: lazyChunk<ChatComposerContextProps>(
            () =>
              import("./branch-toolbar.tsx").then((module) =>
                module.createBranchToolbar(services, drafts),
              ),
            { loading: () => null, failed: () => null },
          ),
        }),
      );
      // Linking pull requests from the thread's menu, before archiving and deleting it.
      const { LinkPullRequest, UnlinkPullRequests, WatchPullRequests } = createLinkActions(
        services,
        dialogs,
      );
      context.subscriptions.add(
        slots.contribute<ThreadActionProps>("thread.actions", {
          id: "jhin.source-control.link-pull-request",
          order: 44,
          component: LinkPullRequest,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ThreadActionProps>("thread.actions", {
          id: "jhin.source-control.watch-pull-requests",
          order: 44.5,
          component: WatchPullRequests,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ThreadActionProps>("thread.actions", {
          id: "jhin.source-control.unlink-pull-requests",
          order: 45,
          component: UnlinkPullRequests,
        }),
      );
      // T3's order in the header: the git actions, then the panel toggles.
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.source-control.git-actions",
          order: -100,
          // Its dialogs load with it, not with the page (D440).
          component: lazyChunk<ChatHeaderActionProps>(
            () =>
              import("./git-actions.tsx").then((module) =>
                module.createGitActionsControl(services),
              ),
            { loading: () => null, failed: () => null },
          ),
        }),
      );
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.source-control.diff-toggle",
          component: DiffToggle,
        }),
      );
      // The diff panel is a chunk of its own, loaded when it first opens (D440).
      const DiffPanel = lazyChunk(
        () => import("./diff-panel.tsx").then((module) => module.createDiffPanel(services)),
        {
          loading: () => null,
          failed: (_props, retry) => (
            <ChunkFailed retry={retry}>Couldn't load the diff panel.</ChunkFailed>
          ),
        },
      );
      function DiffPanelSlot() {
        const route = useExternal(navigation, navigation.current);
        return route.panel === DIFF_PANEL ? <DiffPanel /> : null;
      }
      context.subscriptions.add(
        slots.contribute<ChatTurnFooterProps>("chat.turn.footer", {
          id: "jhin.source-control.changed-files",
          component: createChangedFilesFooter(services, (target, threadId) => {
            const route = navigation.current();
            if (
              route.node === target.node &&
              route.remote === target.remote &&
              route.thread === threadId &&
              route.panel === DIFF_PANEL
            ) {
              return;
            }
            navigation.navigate({
              node: target.node,
              ...(target.remote === undefined ? {} : { remote: target.remote }),
              thread: threadId,
              panel: DIFF_PANEL,
            });
          }),
        }),
      );
      context.subscriptions.add(
        slots.contribute("app.panel", {
          id: "jhin.source-control.diff-panel",
          component: DiffPanelSlot,
        }),
      );
    },
  }),
);
