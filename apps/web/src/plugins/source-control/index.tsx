// The diff toggle follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/PanelLayoutControls.tsx (the header's panel toggles) and
// ChatView.tsx (`diff.toggle`, bound to mod+d outside a terminal).
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatComposerContextProps,
  type ChatHeaderActionProps,
  type Connections,
  type Keybindings,
  type Navigation,
  type ThreadIndicatorProps,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { FileDiffIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal } from "../../lib/hooks.ts";
import { createBranchToolbar } from "./branch-toolbar.tsx";
import { createDiffPanel, DIFF_PANEL } from "./diff-panel.tsx";
import { createCardIndicators } from "./indicators.tsx";
import { useSourceControl, type SourceControlServices } from "./services.ts";
import { createSourceControlStore } from "./store.ts";

/**
 * Source control in the web client (docs/plans/source-control.md): the thread
 * cards' branch, pull request and diff (`sidebar.thread.indicators`), the
 * branch toolbar under the composer (`chat.composer.context`), and the diff
 * panel (`app.panel`) with its toggle in the chat header.
 */
export const sourceControlPlugin = builtin(
  "jhin.source-control",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1", [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const store = context.subscriptions.add(
        createSourceControlStore(connections, threads, context.log),
      );
      const services: SourceControlServices = {
        context,
        store,
        threads,
        navigation,
        toasts,
        shortcut: () => keybindings?.labelFor("diff.toggle"),
      };

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
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
          ]),
        );
      }

      const { Branch, PullRequestIndicator, DiffCount } = createCardIndicators(services);
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
          component: createBranchToolbar(services),
        }),
      );
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.source-control.diff-toggle",
          component: DiffToggle,
        }),
      );
      context.subscriptions.add(
        slots.contribute("app.panel", {
          id: "jhin.source-control.diff-panel",
          component: createDiffPanel(services),
        }),
      );
    },
  }),
);
