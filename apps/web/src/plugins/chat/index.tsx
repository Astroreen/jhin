// Empty states follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/NoActiveThreadState.tsx
// and NoProjectsHero.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  THREAD_TRANSCRIPT_SLOT,
  UNDO_CAPABILITY,
  targetKey,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeTarget,
  type ThreadsCatalog,
  type ThreadTranscriptProps,
  type ThreadUndoService,
  VISITS_CAPABILITY,
  type ThreadVisits,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  copyText,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Spinner,
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { builtin } from "../../lib/builtin.ts";
import { createDrafts, type ComposerDraft } from "../../lib/composer.ts";
import { createModelOptionsMemory } from "../../lib/model-options.ts";
import { createAttachmentUrls } from "../../lib/uploads.ts";
import { useCatalog, useExternal } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { CHAT_SECTION, ChatSettings } from "../../lib/settings.ts";
import {
  ChatContext,
  createAgentsCache,
  createLastSelection,
  useChat,
  type ChatServices,
  type ComposerHandle,
} from "./services.ts";
import { DraftView, ThreadView } from "./thread-view.tsx";
import { ThreadTranscript } from "./transcript.tsx";
import { registerHistory } from "./history.tsx";
import { implementPlan } from "./plan-follow-up.ts";
import { createUnconfirmed } from "./unconfirmed.ts";

/** The page header of a view without a thread. */
function PageHeader({ title }: { title: string }) {
  return (
    <header className="flex h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 border-b border-border pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]">
      <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
        {title}
      </span>
    </header>
  );
}

function Connect({ cancellable }: { cancellable: boolean }) {
  const { connections, navigation } = useChat();
  const [url, setUrl] = useState(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`,
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>();
  const close = () => {
    const { panel: _panel, ...rest } = navigation.current();
    navigation.navigate(rest);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Connect a node" />
      <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-16">
        <form
          aria-label="Connect a node"
          className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border/60 bg-card/40 p-6 shadow-xs/5"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              connections.add({ url, token });
              setError(undefined);
              close();
            } catch (failure) {
              setError(
                failure instanceof z.ZodError
                  ? failure.issues.map((issue) => issue.message).join("; ")
                  : String(failure),
              );
            }
          }}
        >
          <h1 className="text-lg font-semibold">Connect a node</h1>
          <p className="text-sm text-muted-foreground">
            The token is printed by <code>jhin serve</code> on first start, or by{" "}
            <code>jhin auth.token.show</code>.
          </p>
          <Input
            aria-label="Node URL"
            onChange={(event) => setUrl(event.target.value)}
            value={url}
          />
          <Input
            aria-label="Token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="Token"
            type="password"
            value={token}
          />
          {error === undefined ? null : (
            <p className="text-destructive-foreground text-xs" role="alert">
              {error}
            </p>
          )}
          <Button disabled={token === ""} type="submit">
            Connect
          </Button>
          {cancellable ? (
            <Button onClick={close} type="button" variant="outline">
              Cancel
            </Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function Centered({ children, status }: { children: React.ReactNode; status?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Jhin" />
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        role={status === true ? "status" : undefined}
      >
        {children}
      </div>
    </div>
  );
}

function NoActiveThread() {
  const { context, connections, threads, navigation, toasts } = useChat();
  const nodes = useExternal(connections, connections.list);
  const first = nodes.find((node) => node.state === "open") ?? nodes[0]!;
  const catalog = useCatalog(threads, { node: first.id });
  const scratch = catalog?.projects.find((project) => project.scratch);
  const hasProjects = catalog?.projects.some((project) => !project.scratch) === true;
  const start = () => navigation.navigate({ node: first.id, project: scratch?.id ?? "scratch" });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="No active thread" />
      <Empty className="flex-1">
        <div className="w-full max-w-lg px-8 py-12">
          <EmptyHeader className="max-w-none">
            <EmptyTitle>
              {hasProjects ? "Pick a thread to continue" : "What should we work on?"}
            </EmptyTitle>
            <EmptyDescription>
              {hasProjects
                ? "Select an existing thread or create a new one to get started."
                : "Add a project to start your first thread, or start without one."}
            </EmptyDescription>
          </EmptyHeader>
          <div className="mt-6 flex justify-center gap-2">
            <Button
              disabled={first.state !== "open"}
              onClick={() =>
                void context.commands
                  .execute("project.add", { node: first.id })
                  .catch((error: unknown) =>
                    toasts?.show({
                      type: "error",
                      title: "Cannot add a project here",
                      description: (error as Error).message,
                    }),
                  )
              }
              size="sm"
              variant={hasProjects ? "outline" : "default"}
            >
              <PlusIcon className="size-4" />
              Add project
            </Button>
            <Button disabled={first.state !== "open"} onClick={start} size="sm" variant="outline">
              <MessageSquareDashedIcon className="size-4" />
              Start a thread
            </Button>
          </div>
        </div>
      </Empty>
    </div>
  );
}

export const chatPlugin = builtin(
  "jhin.chat",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [SETTINGS_CAPABILITY]: "^1",
    },
    optional: {
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [KEYBINDINGS_CAPABILITY]: "^1",
      [VISITS_CAPABILITY]: "^1",
      [UNDO_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      context.config.define(CHAT_SECTION, ChatSettings);
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const settings = context.services.get<DeviceSettings>(SETTINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const visits = context.services.tryGet<ThreadVisits>(VISITS_CAPABILITY);
      const composer: ComposerHandle = { current: undefined };
      const attachmentUrls = createAttachmentUrls();
      context.subscriptions.add({ dispose: () => attachmentUrls.dispose() });
      const services: ChatServices = {
        context,
        connections,
        navigation,
        mesh,
        threads,
        slots,
        settings,
        toasts,
        dialogs,
        keybindings,
        visits,
        drafts: context.subscriptions.add(createDrafts()),
        agents: createAgentsCache(threads),
        lastSelection: createLastSelection(),
        modelOptions: createModelOptionsMemory(),
        attachmentUrls,
        unconfirmed: createUnconfirmed(),
        composer,
      };

      function Routed() {
        const route = useExternal(navigation, navigation.current);
        const nodes = useExternal(connections, connections.list);
        const node =
          route.node === undefined
            ? undefined
            : nodes.find((candidate) => candidate.id === route.node);
        // Called before any early return: hooks run in the same order every render.
        const members = useMeshMembers(mesh, node?.id);
        const target: NodeTarget | undefined =
          node === undefined
            ? undefined
            : { node: node.id, ...(route.remote === undefined ? {} : { remote: route.remote }) };
        const catalog = useCatalog(threads, target);

        if (route.panel === "settings") return null;
        if (nodes.length === 0 || route.panel === "connect")
          return <Connect cancellable={nodes.length > 0} />;
        if (node?.state === "open" && route.remote !== undefined && members === undefined) {
          // Judge a remote route only once the mesh has answered (it always does).
          return (
            <Centered status>
              <p className="text-sm text-muted-foreground">Finding the node…</p>
            </Centered>
          );
        }
        if (
          node !== undefined &&
          route.remote !== undefined &&
          members !== undefined &&
          !members.some((member) => member.nodeId === route.remote && member.reachable)
        ) {
          // A remote node that left the mesh, or a deep link to an unknown one.
          return (
            <Centered status>
              <p className="text-sm font-medium">Node unreachable</p>
              <p className="text-sm text-muted-foreground">
                {node.label} has no route to it now. Its threads come back when it does.
              </p>
            </Centered>
          );
        }
        if (node === undefined || target === undefined || catalog === undefined)
          return <NoActiveThread />;
        const nodeLabel =
          route.remote === undefined
            ? node.label
            : (members?.find((member) => member.nodeId === route.remote)?.name ?? route.remote);
        if (route.thread !== undefined) {
          const thread = catalog.threads.find((candidate) => candidate.id === route.thread);
          const project = catalog.projects.find((candidate) => candidate.id === thread?.projectId);
          return (
            <ThreadView
              connected={node.state === "open"}
              key={`${node.id}:${route.remote ?? ""}:${route.thread}`}
              nodeLabel={nodeLabel}
              project={project}
              target={target}
              thread={thread}
              threadId={route.thread}
            />
          );
        }
        if (route.project !== undefined) {
          const project = catalog.projects.find((candidate) => candidate.id === route.project);
          if (project === undefined) {
            return catalog.status === "loading" ? (
              <Centered status>
                <Spinner size="lg" tone="muted" />
              </Centered>
            ) : (
              <NoActiveThread />
            );
          }
          return (
            <DraftView
              connected={node.state === "open"}
              key={`${node.id}:${route.remote ?? ""}:${project.id}`}
              nodeLabel={nodeLabel}
              project={project}
              target={target}
            />
          );
        }
        return <NoActiveThread />;
      }

      function Main() {
        return (
          <ChatContext.Provider value={services}>
            <Routed />
          </ChatContext.Provider>
        );
      }

      // --- Commands -------------------------------------------------------------
      // T3's "Discard draft" (D451): a new thread's draft card goes, with an undo.
      const undo = context.services.tryGet<ThreadUndoService>(UNDO_CAPABILITY);
      context.commands.register({
        name: "chat.draft.discard",
        title: "Discard draft",
        description:
          "Discards the draft of a new thread in a project (its text and images), leaving it if open; the sidebar offers to undo it",
        input: z.object({
          node: z.string(),
          remote: z.string().optional(),
          projectId: z.string(),
        }),
        output: z.object({ discarded: z.boolean() }),
        handler: async (input) => {
          const target: NodeTarget = {
            node: input.node,
            ...(input.remote === undefined ? {} : { remote: input.remote }),
          };
          const key = `${targetKey(target)}|draft|${input.projectId}`;
          const draftRoute = { ...target, project: input.projectId };
          const isOpen = () => {
            const route = navigation.current();
            return (
              route.thread === undefined &&
              route.project === input.projectId &&
              route.node === target.node &&
              route.remote === target.remote
            );
          };
          let kept: ComposerDraft | undefined;
          const perform = async () => {
            kept = services.drafts.get(key);
            const open = isOpen();
            if (kept === undefined && !open) return false;
            // Away first: the composer that shows it keeps no text to write back.
            if (open) navigation.navigate({});
            services.drafts.set(key, { prompt: "", attachments: [] });
            services.drafts.flush();
            return true;
          };
          const revert = async () => {
            if (services.drafts.get(key) !== undefined)
              throw new Error("The draft has new content.");
            if (kept !== undefined) services.drafts.set(key, kept);
            navigation.navigate(draftRoute);
          };
          const discarded =
            undo === undefined
              ? await perform()
              : await undo.run({
                  kind: "discard",
                  key,
                  action: "Discarded",
                  noun: "draft",
                  failureTitle: "Failed to restore draft",
                  perform,
                  revert,
                });
          return { discarded };
        },
      });

      /** A failure reaches whoever ran the command (the palette shows it, a shortcut logs it). */
      const register = (
        name: string,
        title: string,
        description: string,
        run: () => void | Promise<unknown>,
      ) =>
        context.commands.register({
          name,
          title,
          description,
          input: z.object({}),
          output: z.object({}),
          handler: async () => {
            await run();
            return {};
          },
        });
      register(
        "chat.composer.focus",
        "Focus the composer",
        "Puts the cursor in the message box",
        () => composer.current?.focus(),
      );
      register(
        "chat.model-picker.toggle",
        "Change model",
        "Opens the composer's model picker",
        () => composer.current?.toggleModelPicker(),
      );
      register(
        "chat.runtime-mode.cycle",
        "Change access mode",
        "Switches Supervised → Auto-accept edits → Full access",
        () => composer.current?.cycleRuntimeMode(),
      );
      register("chat.plan.toggle", "Toggle plan mode", "Switches between plan and build mode", () =>
        composer.current?.togglePlanMode(),
      );
      // The queue's shortcuts and the composer's other send, T3's
      // thread.steerQueuedMessage, thread.editQueuedMessage and composer.sendAlternate (D210).
      register(
        "chat.queue.steer-next",
        "Steer the next queued message",
        "Sends the open thread's first queued message into its running turn",
        () => void composer.current?.steerNext(),
      );
      register(
        "chat.queue.edit-latest",
        "Edit the last queued message",
        "Loads the open thread's last queued message into the composer to change it",
        () => void composer.current?.editLatest(),
      );
      register(
        "chat.composer.send-alternate",
        "Send the other way",
        "While a turn runs, steers the composer's message when follow-ups queue, or queues it when they steer",
        () => composer.current?.sendAlternate(),
      );
      register(
        "chat.stop",
        "Stop the running turn",
        "Interrupts the agent in the open thread",
        async () => {
          const route = navigation.current();
          if (route.node === undefined || route.thread === undefined) return;
          await threads.call(
            { node: route.node, ...(route.remote === undefined ? {} : { remote: route.remote }) },
            "threads.interrupt",
            { threadId: route.thread },
          );
        },
      );
      register("chat.thread.copy-id", "Copy thread ID", "Copies the open thread's id", async () => {
        const route = navigation.current();
        if (route.thread === undefined) return;
        await copyText(route.thread);
        toasts?.show({ type: "success", title: "Thread ID copied", timeout: 1500 });
      });
      // "Implement this plan" (D306): the open thread's, or the one named.
      const PlanTarget = z.object({
        node: z.string().optional(),
        remote: z.string().optional(),
        threadId: z.string().optional(),
      });
      const planCommand = (name: string, title: string, description: string, newThread: boolean) =>
        context.commands.register({
          name,
          title,
          description,
          input: PlanTarget,
          output: z.object({ threadId: z.string(), uncertain: z.string().optional() }),
          handler: async (input) => {
            const route = navigation.current();
            const node = input.node ?? route.node;
            const remote = input.node === undefined ? route.remote : input.remote;
            const threadId = input.threadId ?? route.thread;
            if (node === undefined || threadId === undefined) {
              throw Object.assign(new Error("No thread is open"), { code: "THREAD_NOT_FOUND" });
            }
            const target = { node, ...(remote === undefined ? {} : { remote }) };
            return implementPlan({ threads, navigation }, { target, threadId, newThread });
          },
        });
      planCommand(
        "chat.plan.implement",
        "Implement this plan",
        "Sends the thread's proposed plan to be implemented, in build mode",
        false,
      );
      planCommand(
        "chat.plan.implement-new-thread",
        "Implement in a new thread",
        "Starts a thread in the same project that implements the proposed plan",
        true,
      );
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+shift+m", command: "chat.model-picker.toggle", when: "!terminalFocus" },
            { key: "mod+shift+a", command: "chat.runtime-mode.cycle", when: "!terminalFocus" },
            {
              key: "mod+shift+c",
              command: "chat.thread.copy-id",
              when: "!terminalFocus && !editableFocus",
            },
            { key: "mod+l", command: "chat.composer.focus", when: "!terminalFocus" },
            {
              key: "mod+shift+enter",
              command: "chat.queue.steer-next",
              when: "!terminalFocus && queuedMessages && turnRunning && !composerHasText",
            },
            {
              key: "alt+arrowup",
              command: "chat.queue.edit-latest",
              when: "composerFocus && queuedMessages && composerCaretAtStart",
            },
          ]),
        );
      }

      context.subscriptions.add(
        slots.contribute("app.main", { id: "jhin.chat.view", component: Main }),
      );
      // A thread read without a composer, for views such as an agent's page (D614).
      context.subscriptions.add(
        slots.contribute(THREAD_TRANSCRIPT_SLOT, {
          id: "jhin.chat.transcript",
          component: (props: ThreadTranscriptProps) => (
            <ChatContext.Provider value={services}>
              <ThreadTranscript {...props} />
            </ChatContext.Provider>
          ),
        }),
      );
      registerHistory(context, {
        threads,
        navigation,
        slots,
        drafts: services.drafts,
        composer,
        dialogs,
        toasts,
      });
    },
  }),
);
