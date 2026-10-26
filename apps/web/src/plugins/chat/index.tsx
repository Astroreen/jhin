// Empty states follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/NoActiveThreadState.tsx
// and NoProjectsHero.tsx.
import { AssistantCitationSchema, MessageContextRecordSchema } from "@jhin/agent-api";
import {
  CHAT_DRAFTS_CAPABILITY,
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  RIGHT_PANEL_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  THREAD_TRANSCRIPT_SLOT,
  UNDO_CAPABILITY,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeTarget,
  type RightPanel,
  type RightPanelSurfaceProps,
  type ThreadsCatalog,
  type ThreadTranscriptProps,
  type ThreadUndoService,
  VISITS_CAPABILITY,
  HISTORY_CACHE_CAPABILITY,
  type ThreadVisits,
  type HistoryCache,
  type ChatDrafts,
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
import { FileIcon, FilesIcon, MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { builtin } from "../../lib/builtin.ts";
import {
  createDrafts,
  newThreadDraftKey,
  nodeDraftKey,
  threadDraftKey,
  type ComposerDraft,
} from "../../lib/composer.ts";
import { draftContextsReader } from "../../lib/composer-context.ts";
import { createModelOptionsMemory } from "../../lib/model-options.ts";
import { createAttachmentUrls } from "../../lib/uploads.ts";
import { useCatalog, useExternal } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import {
  CHAT_SECTION,
  ChatSettings,
  readSection,
  SYNC_SECTION,
  SyncSettings,
} from "../../lib/settings.ts";
import {
  ChatContext,
  createAgentsCache,
  createLastSelection,
  useChat,
  type ChatServices,
  type ComposerHandle,
} from "./services.ts";
import { DraftView, ThreadView } from "./thread-view.tsx";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { createDetailsVisibility, registerThreadDetails } from "./thread-details.tsx";
import type {
  AttachmentPanel as AttachmentPanelComponent,
  FilePanelProps,
  FilesPanel as FilesPanelComponent,
} from "./file-panel.tsx";
import {
  ATTACHMENT_PANEL,
  createFileReveals,
  FILE_PANEL,
  FILES_PANEL,
  parseAttachmentResource,
} from "./file-panel-route.ts";
import { basename } from "./file-chips.tsx";
import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import { armPasteAsText, consumeArmedPasteAsText } from "../../lib/attachment-files.ts";
import { registerHistory } from "./history.tsx";
import { implementPlan } from "./plan-follow-up.ts";
import { createUnconfirmed } from "./unconfirmed.ts";
import { looksLikePairingCode, parsePairingUrl, rpcUrl } from "../../lib/session.ts";

/** The page header of a view without a thread. */
function PageHeader({ title }: { title: string }) {
  return (
    <header className="drag-region flex h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 border-b border-border pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) wco:pr-(--workspace-native-controls-inset) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]">
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
  const [typedError, setError] = useState<string | undefined>();
  // The page's own credential is checked in the background; its refusal shows when it comes.
  const refused = useExternal(connections, () => connections.refusedCredential?.());
  const error = typedError ?? refused;
  const [pairing, setPairing] = useState(false);
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
            const report = (failure: unknown) =>
              setError(
                failure instanceof z.ZodError
                  ? failure.issues.map((issue) => issue.message).join("; ")
                  : failure instanceof Error
                    ? failure.message
                    : String(failure),
              );
            // A pairing link names its node; a pairing code pairs with the node above (D424).
            const link = parsePairingUrl(url) ?? parsePairingUrl(token);
            // A pairing link carries its own code: a typed one beside it is not dropped silently.
            if (parsePairingUrl(url) !== undefined && token.trim() !== "") {
              setError("The pairing link has its own code: clear the code or token field.");
              return;
            }
            const target =
              link?.url ??
              (URL.canParse(url) && /^https?:$/.test(new URL(url).protocol) ? rpcUrl(url) : url);
            const code = link?.code ?? (looksLikePairingCode(token) ? token : undefined);
            if (code !== undefined && connections.pair !== undefined) {
              setPairing(true);
              connections
                .pair({ url: target, code })
                .then(() => {
                  setError(undefined);
                  close();
                }, report)
                .finally(() => setPairing(false));
              return;
            }
            try {
              connections.add({ url: target, token });
              setError(undefined);
              close();
            } catch (failure) {
              report(failure);
            }
          }}
        >
          <h1 className="text-lg font-semibold">Connect a node</h1>
          <p className="text-sm text-muted-foreground">
            Paste a pairing link, or a pairing code from <code>jhin pair</code> or the node&apos;s
            Authorized clients settings. A token printed by <code>jhin serve</code> works too.
          </p>
          <Input
            aria-label="Node URL"
            onChange={(event) => setUrl(event.target.value)}
            value={url}
          />
          <Input
            aria-label="Pairing code or token"
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
            placeholder="PAIRCODE"
            type="password"
            value={token}
          />
          {error === undefined ? null : (
            <p className="text-destructive-foreground text-xs" role="alert">
              {error}
            </p>
          )}
          <Button
            disabled={pairing || (token === "" && parsePairingUrl(url) === undefined)}
            type="submit"
          >
            {pairing ? "Pairing…" : "Connect"}
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

/** The read-only transcript (D614), a chunk of its own: only Civilization mode shows it (D440). */
const Transcript = lazyChunk(
  () => import("./transcript.tsx").then((module) => module.ThreadTranscript),
  {
    loading: () => null,
    failed: (_props, retry) => (
      <ChunkFailed retry={retry}>Couldn't load this conversation.</ChunkFailed>
    ),
  },
);

/** T3's file explorer as a surface (D1428), in the file panel's chunk. */
const FilesPanel = lazyChunk<Parameters<typeof FilesPanelComponent>[0]>(
  () => import("./file-panel.tsx").then((module) => module.FilesPanel),
  {
    loading: () => null,
    failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load the files.</ChunkFailed>,
  },
);

/** A message's file in the right panel (D1435), in the file panel's chunk. */
const AttachmentPanel = lazyChunk<Parameters<typeof AttachmentPanelComponent>[0]>(
  () => import("./file-panel.tsx").then((module) => module.AttachmentPanel),
  {
    loading: () => null,
    failed: (_props, retry) => (
      <ChunkFailed retry={retry}>Couldn't load the file preview.</ChunkFailed>
    ),
  },
);

/** A mentioned file beside the thread (D1342), a chunk of its own loaded when it first opens. */
const FilePanel = lazyChunk<FilePanelProps>(
  () => import("./file-panel.tsx").then((module) => module.FilePanel),
  {
    loading: () => null,
    failed: (_props, retry) => (
      <ChunkFailed retry={retry}>Couldn't load the file preview.</ChunkFailed>
    ),
  },
);

export const chatPlugin = builtin(
  "jhin.chat",
  {
    provides: { [CHAT_DRAFTS_CAPABILITY]: "1.1.0" },
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
      // A mentioned file as a surface of the right panel (t3-parity.md D1424).
      [RIGHT_PANEL_CAPABILITY]: "^1",
      [HISTORY_CACHE_CAPABILITY]: "^1",
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
      const historyCache = context.services.tryGet<HistoryCache>(HISTORY_CACHE_CAPABILITY);
      const composer: ComposerHandle = { current: undefined };
      // Shared through each thread's node unless this device turned it off (D486, D488).
      const syncDrafts = () => readSection(context, SYNC_SECTION, SyncSettings).drafts;
      const drafts = context.subscriptions.add(
        createDrafts(localStorage, {
          send(key, prompt, at) {
            const node = nodeDraftKey(key);
            if (node === undefined || !syncDrafts()) return;
            void threads
              .call(node.target, "threads.draft.set", { key: node.key, prompt, at })
              .catch(() => undefined);
          },
        }),
      );
      // Following other devices' drafts loads in a chunk of its own (D440).
      let draftsStopped = false;
      let draftsFeed: { dispose(): void } | undefined;
      void import("./drafts-sync.ts")
        .then(({ followDrafts }) => {
          if (!draftsStopped) draftsFeed = followDrafts(connections, drafts, syncDrafts);
        })
        .catch((error: unknown) =>
          context.log.warn("drafts of other devices not followed", { error: String(error) }),
        );
      context.subscriptions.add({
        dispose: () => {
          draftsStopped = true;
          draftsFeed?.dispose();
        },
      });
      const attachmentUrls = createAttachmentUrls();
      context.subscriptions.add({ dispose: () => attachmentUrls.dispose() });
      const services: ChatServices = {
        fileReveals: createFileReveals(),
        rightPanel: context.services.tryGet<RightPanel>(RIGHT_PANEL_CAPABILITY),
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
        drafts,
        agents: createAgentsCache(threads),
        lastSelection: createLastSelection(),
        modelOptions: createModelOptionsMemory(),
        attachmentUrls,
        unconfirmed: createUnconfirmed(),
        composer,
        threadFind: { current: undefined },
        threadDetails: createDetailsVisibility(),
        historyCache,
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

        // A page of its own over the main area (settings, the Usage page of D1308); the
        // right panel's views (preview, diff, terminals) are panels too and keep the chat.
        if (route.panel === "settings" || route.panel === "usage") return null;
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

      const draftContexts = draftContextsReader();
      // Which threads keep an unsent draft, for their cards (t3-parity.md D963).
      context.services.provide<ChatDrafts>(CHAT_DRAFTS_CAPABILITY, {
        hasThreadDraft: (target, threadId) => {
          // Blank text alone is no draft (T3's composerDraftHasUserContent).
          const draft = services.drafts.get(threadDraftKey(target, threadId));
          return (
            draft !== undefined && (draft.prompt.trim() !== "" || draft.attachments.length > 0)
          );
        },
        contexts: (target, threadId) =>
          draftContexts(services.drafts.get(threadDraftKey(target, threadId))),
        subscribe: (listener) => services.drafts.subscribe(listener),
      });

      // --- Commands -------------------------------------------------------------
      context.commands.register({
        name: "chat.composer.paste-as-text",
        description:
          "Makes the next paste into the composer stay inline as text, however large (T3's Paste as Text); it applies to a paste within a second",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          armPasteAsText();
          return {};
        },
      });
      // The paste that follows spends the arm wherever it lands: the composer reads
      // it first, any other field's paste bubbles here and clears it.
      const spendPasteAsText = () => void consumeArmedPasteAsText();
      window.addEventListener("paste", spendPasteAsText);
      context.subscriptions.add({
        dispose: () => window.removeEventListener("paste", spendPasteAsText),
      });
      // T3's hand-off into a new thread's draft (`usePullRequestHandoffs`, source-control.md
      // D1456): the task goes after what the draft holds, then the draft opens.
      context.commands.register({
        name: "chat.draft.write",
        title: "Write into a new thread's draft",
        description:
          "Puts a prompt into the draft of a new thread in a project, after the text it holds, and opens that draft unless `open` is false; nothing is sent",
        input: z.object({
          node: z.string(),
          remote: z.string().optional(),
          projectId: z.string().min(1),
          prompt: z.string().min(1).max(200_000),
          open: z.boolean().optional(),
        }),
        output: z.object({ written: z.boolean() }),
        handler: (input) => {
          const target: NodeTarget = {
            node: input.node,
            ...(input.remote === undefined ? {} : { remote: input.remote }),
          };
          const key = newThreadDraftKey(target, input.projectId);
          const shown = composer.current?.draftKey === key ? composer.current : undefined;
          if (shown !== undefined) {
            // An open draft's composer holds its text itself: the task goes in there.
            shown.insert(input.prompt);
          } else {
            const kept = services.drafts.get(key);
            const prompt =
              kept === undefined || kept.prompt.trim() === ""
                ? input.prompt
                : `${kept.prompt}\n\n${input.prompt}`;
            services.drafts.set(key, { ...(kept ?? { attachments: [] }), prompt });
            services.drafts.flush();
          }
          if (input.open !== false && shown === undefined) {
            navigation.navigate({ ...target, project: input.projectId });
          }
          return { written: true };
        },
      });
      // T3's "Discard draft" (D451): a new thread's draft card goes, with an undo.
      const undo = context.services.tryGet<ThreadUndoService>(UNDO_CAPABILITY);
      context.commands.register({
        name: "chat.draft.discard",
        title: "Discard draft",
        description:
          "Discards the draft of a new thread in a project, or of a thread's composer with `threadId` (its text and images), leaving a new thread's draft if open; the sidebar offers to undo it",
        input: z
          .object({
            node: z.string(),
            remote: z.string().optional(),
            projectId: z.string().optional(),
            threadId: z.string().optional(),
          })
          .refine((value) => (value.projectId === undefined) !== (value.threadId === undefined), {
            message: "Give a projectId or a threadId",
          }),
        output: z.object({ discarded: z.boolean() }),
        handler: async (input) => {
          const target: NodeTarget = {
            node: input.node,
            ...(input.remote === undefined ? {} : { remote: input.remote }),
          };
          // A thread's composer draft (T3's X on its card, t3-parity.md D963).
          const threadId = input.threadId;
          const { projectId } = input;
          const key =
            threadId !== undefined
              ? threadDraftKey(target, threadId)
              : projectId !== undefined
                ? newThreadDraftKey(target, projectId)
                : undefined;
          if (key === undefined) throw new Error("Give a projectId or a threadId");
          const draftRoute = {
            ...target,
            ...(input.projectId === undefined ? {} : { project: input.projectId }),
          };
          const isOpen = () => {
            if (threadId !== undefined) return false;
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
            // An open thread's composer holds its text itself and would write it back.
            if (threadId !== undefined && composer.current?.draftKey === key) {
              throw new Error("The thread is open: clear its composer there.");
            }
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
            const open = composer.current?.draftKey === key ? composer.current : undefined;
            const current = open === undefined ? services.drafts.get(key) : open.draft();
            if (
              current !== undefined &&
              (current.prompt.trim() !== "" || current.attachments.length > 0)
            )
              throw new Error("The draft has new content.");
            if (kept === undefined) return;
            // Opened meanwhile: its composer holds the text, so it takes it back itself.
            if (open !== undefined) open.restore(kept);
            else services.drafts.set(key, kept);
            if (threadId === undefined && open === undefined) navigation.navigate(draftRoute);
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
      /** A command that answers whether it did anything (`done`, D806), as the palette and MCP need. */
      const answer = (
        name: string,
        title: string,
        description: string,
        run: () => boolean | Promise<boolean>,
      ) =>
        context.commands.register({
          name,
          title,
          description,
          input: z.object({}),
          output: z.object({ done: z.boolean() }),
          handler: async () => ({ done: await run() }),
        });
      register(
        "chat.composer.focus",
        "Focus the composer",
        "Puts the cursor in the message box",
        () => composer.current?.focus(),
      );
      context.commands.register({
        name: "chat.composer.insert",
        title: "Insert into the composer",
        description:
          "Puts text into the open thread's message box, at the cursor when it has focus, else at the end, as the terminal's Add to chat does",
        input: z.object({ text: z.string().min(1).max(200_000) }),
        output: z.object({ inserted: z.boolean() }),
        handler: ({ text }) => {
          const target = composer.current;
          if (target === undefined) return { inserted: false };
          target.insert(text);
          return { inserted: true };
        },
      });
      // T3's addTerminalContext (D1009): a record and its chip, not text.
      context.commands.register({
        name: "chat.composer.insert-context",
        title: "Add context to the composer",
        description:
          "Puts a context record (a terminal excerpt, a pull request, a thread) beside the open thread's message, its chip at the cursor when the box has focus, else at the end",
        input: z.object({ record: MessageContextRecordSchema }),
        output: z.object({
          inserted: z.boolean(),
          /** Why not: no composer open, one that takes no context now, or one holding T3's 200. */
          reason: z.enum(["no-composer", "not-now", "full"]).optional(),
        }),
        handler: ({ record }) => {
          const target = composer.current;
          if (target === undefined) return { inserted: false, reason: "no-composer" as const };
          const done = target.insertContext(record);
          return done === "inserted" ? { inserted: true } : { inserted: false, reason: done };
        },
      });
      // A file into the open thread's message, as the paperclip attaches it (desktop.md D1491).
      context.commands.register({
        name: "chat.composer.attach",
        title: "Attach files to the composer",
        description:
          "Attaches files (base64) to the open thread's message, as the paperclip does; an annotation of a preview page attaches its screenshot so",
        input: z.object({
          files: z
            .array(
              z.object({
                name: z.string().min(1).max(255),
                mimeType: z.string().min(1).max(255),
                data: z.string().max(64 * 1024 * 1024),
              }),
            )
            .min(1)
            .max(20),
        }),
        output: z.object({ attached: z.boolean() }),
        handler: ({ files }) => {
          const target = composer.current;
          if (target === undefined) return { attached: false };
          target.attach(
            files.map(
              (file) =>
                new File(
                  [Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))],
                  file.name,
                  {
                    type: file.mimeType,
                  },
                ),
            ),
          );
          return { attached: true };
        },
      });
      // Sends what the composer holds, as Enter does (T3's annotation "Send", desktop.md D1491).
      context.commands.register({
        name: "chat.composer.send",
        title: "Send the message",
        description:
          "Sends the open thread's message as Enter does; sent is false when there is nothing to send",
        input: z.object({}),
        output: z.object({ sent: z.boolean() }),
        handler: async () => ({ sent: (await composer.current?.send()) ?? false }),
      });
      // T3's removeReviewComment (D1286): a record's chips go, with the record.
      context.commands.register({
        name: "chat.composer.remove-context",
        description:
          "Takes a context record (a review comment, a terminal excerpt, …) and its chips out of the open thread's message; `removed` is false when the message names no such record",
        input: z.object({ contextId: z.string().min(1) }),
        output: z.object({ removed: z.boolean() }),
        handler: ({ contextId }) => ({
          removed: composer.current?.removeContext(contextId) ?? false,
        }),
      });
      // T3's onCite (D1012): a quote of an agent's message as its chip, not text.
      context.commands.register({
        name: "chat.composer.insert-citation",
        title: "Quote in the composer",
        description:
          "Puts a quote of an agent's message (its text, place and an optional comment) into the open thread's message, its chip at the cursor when the box has focus, else at the end",
        input: z.object({ citation: AssistantCitationSchema }),
        output: z.object({
          inserted: z.boolean(),
          reason: z.enum(["no-composer", "not-now", "full"]).optional(),
        }),
        handler: ({ citation }) => {
          const target = composer.current;
          if (target === undefined) return { inserted: false, reason: "no-composer" as const };
          const done = target.insertCitation(citation);
          return done === "inserted" ? { inserted: true } : { inserted: false, reason: done };
        },
      });
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
      answer(
        "chat.queue.steer-next",
        "Steer the next queued message",
        "Sends the open thread's first queued message into its running turn; `done` is false when there was none to steer",
        () => composer.current?.steerNext() ?? false,
      );
      answer(
        "chat.queue.edit-latest",
        "Edit the last queued message",
        "Loads the open thread's last queued message into the composer to change it; `done` is false when it could not",
        () => composer.current?.editLatest() ?? false,
      );
      // T3's find in the thread (D801).
      register("chat.find", "Find in thread", "Opens the find bar of the open thread", () =>
        services.threadFind.current?.open(),
      );
      // T3's "Resume thread" for a stopped turn or a held queue (D800).
      context.commands.register({
        name: "chat.thread.resume",
        title: "Resume thread",
        description:
          "Continues the open thread's stopped turn, then lets its held queue go on. `resumed` says a resume started (its failure shows in the thread), false when there was nothing to resume or text is typed",
        input: z.object({}),
        output: z.object({ resumed: z.boolean() }),
        handler: () => ({ resumed: composer.current?.resume() ?? false }),
      });
      answer(
        "chat.composer.send-alternate",
        "Send the other way",
        "While a turn runs, steers the composer's message when follow-ups queue, or queues it when they steer; `done` is false when nothing was sent",
        () => composer.current?.sendAlternate() ?? false,
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
              key: "mod+f",
              command: "chat.find",
              when: "threadOpen && !terminalFocus && !previewFocus",
            },
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
      // T3's right-hand file panel (D1342): while the route's panel is `file`, its section the path.
      // Beside the right panel each file is a surface `file:<path>` of it (D1424).
      const rightPanel = context.services.tryGet<RightPanel>(RIGHT_PANEL_CAPABILITY);
      if (rightPanel !== undefined) {
        context.subscriptions.add(
          rightPanel.register({
            id: FILE_PANEL,
            title: "File",
            icon: FileIcon,
            useTab: ({ surface }) => {
              const theme = useResolvedTheme();
              const path = surface.resource ?? "";
              return {
                title: basename(path),
                icon: (
                  <PierreEntryIcon className="size-3" kind="file" pathValue={path} theme={theme} />
                ),
              };
            },
            // T3's "Copy path" of a file's tab.
            menuItems: ({ surface }) =>
              surface.resource === undefined
                ? []
                : [
                    {
                      id: "copy-path",
                      label: "Copy path",
                      onSelect: () => void copyText(surface.resource!).catch(() => undefined),
                    },
                  ],
            component: function FileSurface({ place, surface }: RightPanelSurfaceProps) {
              if (surface.resource === undefined) return null;
              return (
                <ChatContext.Provider value={services}>
                  <FilePanel
                    embedded
                    key={`${place.target.node}|${place.target.remote ?? ""}|${place.threadId ?? place.projectId ?? ""}`}
                    onClose={() => void rightPanel.close(place, surface.id)}
                    onOpenFile={(path) =>
                      rightPanel.open(place, { kind: FILE_PANEL, resource: path })
                    }
                    path={surface.resource}
                    projectId={place.threadId === undefined ? place.projectId : undefined}
                    target={place.target}
                    threadId={place.threadId}
                  />
                </ChatContext.Provider>
              );
            },
          }),
        );
      }
      if (rightPanel !== undefined) {
        // A message's file, T3's `attachment:<id>` surface (D1435): offered by no entry.
        context.subscriptions.add(
          rightPanel.register({
            id: ATTACHMENT_PANEL,
            title: "Attachment",
            icon: FileIcon,
            useTab: ({ surface }) => {
              const theme = useResolvedTheme();
              const name = parseAttachmentResource(surface.resource ?? "")?.name ?? "Attachment";
              return {
                title: name,
                icon: (
                  <PierreEntryIcon className="size-3" kind="file" pathValue={name} theme={theme} />
                ),
              };
            },
            component: function AttachmentSurface({ place, surface }: RightPanelSurfaceProps) {
              const attachment = parseAttachmentResource(surface.resource ?? "");
              if (attachment === undefined) return null;
              return (
                <ChatContext.Provider value={services}>
                  <AttachmentPanel attachment={attachment} target={place.target} />
                </ChatContext.Provider>
              );
            },
          }),
        );
        // T3's "Files" (F): the explorer, which a file opened from it takes the place of (D1428).
        context.subscriptions.add(
          rightPanel.register({
            id: FILES_PANEL,
            title: "Files",
            icon: FilesIcon,
            offer: {
              label: "Files",
              shortcut: "F",
              order: 30,
              useAvailability: (place) =>
                place.threadId === undefined && place.projectId === undefined
                  ? {
                      available: false,
                      reason: "Files are only available when a project is open.",
                      hint: "Available when a project is open.",
                    }
                  : { available: true },
            },
            component: function FilesSurface({ place, surface }: RightPanelSurfaceProps) {
              return (
                <ChatContext.Provider value={services}>
                  <FilesPanel
                    onOpenFile={(path) => {
                      rightPanel.open(place, { kind: FILE_PANEL, resource: path });
                      void rightPanel.close(place, surface.id);
                    }}
                    projectId={place.threadId === undefined ? place.projectId : undefined}
                    target={place.target}
                    threadId={place.threadId}
                  />
                </ChatContext.Provider>
              );
            },
          }),
        );
      }
      context.subscriptions.add(
        slots.contribute("app.panel", {
          id: "jhin.chat.file-panel",
          component: function FilePanelSlot() {
            const route = useExternal(navigation, navigation.current);
            if (
              rightPanel !== undefined ||
              route.panel !== FILE_PANEL ||
              !route.section ||
              route.node === undefined
            ) {
              return null;
            }
            const { panel: _panel, section: _section, ...rest } = route;
            return (
              <ChatContext.Provider value={services}>
                <FilePanel
                  key={`${route.node}|${route.remote ?? ""}|${route.thread ?? route.project ?? ""}`}
                  onClose={() => navigation.navigate(rest)}
                  path={route.section}
                  projectId={route.thread === undefined ? route.project : undefined}
                  target={{
                    node: route.node,
                    ...(route.remote === undefined ? {} : { remote: route.remote }),
                  }}
                  threadId={route.thread}
                />
              </ChatContext.Provider>
            );
          },
        }),
      );
      // A thread read without a composer, for views such as an agent's page (D614).
      context.subscriptions.add(
        slots.contribute(THREAD_TRANSCRIPT_SLOT, {
          id: "jhin.chat.transcript",
          component: (props: ThreadTranscriptProps) => (
            <ChatContext.Provider value={services}>
              <Transcript {...props} />
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
      registerThreadDetails(context, {
        threads,
        navigation,
        slots,
        keybindings,
        visibility: services.threadDetails,
      });
    },
  }),
);
