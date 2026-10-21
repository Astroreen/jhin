// "Edit from here", forks and merging back follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/MessagesTimeline.tsx (RevertUserMessageButton, AssistantForkButton,
// the hover row of a message), ChatOverlayHosts.tsx (the confirmation), ChatView.tsx
// (rewindToMessage, onForkFromRun) and ThreadRelationshipsControl.tsx (merging back).
import type { TurnAttachment } from "@jhin/agent-api";
import type {
  ChatHeaderActionProps,
  ChatMessageActionProps,
  Navigation,
  NodeTarget,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import { z, type PluginContext } from "@jhin/sdk";
import {
  Button,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { GitForkIcon, GitMergeIcon, RefreshCwIcon, Undo2Icon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import {
  appendToDraft,
  restoreIntoDraft,
  threadDraftKey,
  type Drafts,
} from "../../lib/composer.ts";
import { useCatalog } from "../../lib/hooks.ts";
import type { ComposerHandle } from "./services.ts";
import { MessageCopyButton } from "./timeline.tsx";

const At = { node: z.string(), remote: z.string().optional() };

const targetOf = (input: { node: string; remote?: string | undefined }): NodeTarget => ({
  node: input.node,
  ...(input.remote === undefined ? {} : { remote: input.remote }),
});

/**
 * "Edit from here" (D223): checks the message fits beside what the thread's
 * composer holds, asks, rolls back to before the turn and puts the message
 * back, into the composer on screen or else the thread's stored draft.
 */
export async function editFromHere(
  services: {
    readonly threads: Pick<ThreadsCatalog, "call">;
    readonly drafts: Pick<Drafts, "get" | "set">;
    readonly composer: ComposerHandle;
    readonly dialogs: Pick<Dialogs, "confirm" | "choose"> | undefined;
    readonly toasts: Pick<Toasts, "show"> | undefined;
  },
  input: {
    readonly node: string;
    readonly remote?: string | undefined;
    readonly threadId: string;
    readonly turnId: string;
    readonly confirmed?: boolean | undefined;
    /** With `confirmed`: put the files back as before the message too (W3, D257). */
    readonly restoreFiles?: boolean | undefined;
  },
): Promise<{ edited: boolean }> {
  const { threads, drafts, composer, dialogs, toasts } = services;
  const target = targetOf(input);
  const key = threadDraftKey(target, input.threadId);
  const turn = await threads
    .call<{
      input: { text: string; attachments?: TurnAttachment[] };
    }>(target, "threads.turn", { threadId: input.threadId, turnId: input.turnId })
    .catch((failure: unknown) => {
      toasts?.show({
        type: "error",
        title: "Failed to revert thread state.",
        description: String((failure as Error).message ?? failure),
      });
      throw failure;
    });
  // Uploads go back by id; D54's data URLs have no upload to keep.
  const message = {
    prompt: turn.input.text,
    attachments: (turn.input.attachments ?? []).filter((item) => "id" in item),
  };
  /** What the thread's composer holds now: the one on screen, else the stored draft. */
  const draftNow = () =>
    composer.current?.draftKey === key ? composer.current.draft() : drafts.get(key);
  if (restoreIntoDraft(draftNow(), message) === undefined) {
    toasts?.show({
      type: "error",
      title: "Make room for this message's attachments in the composer before rewinding.",
    });
    return { edited: false };
  }
  // A destructive rewind is never taken as agreed when nobody can be asked.
  const options = {
    title: "Edit from here?",
    description:
      "Rewind chat to before this message. Your prompt and attachments return to the composer.",
    confirmLabel: "Revert and keep changes",
  };
  // T3's third way, its files reverted too (W3, D257), where the dialogs can offer it.
  const choice =
    input.confirmed === true
      ? input.restoreFiles === true
        ? "alternative"
        : "confirm"
      : dialogs === undefined
        ? undefined
        : dialogs.choose !== undefined
          ? await dialogs.choose({
              ...options,
              alternativeLabel: "Revert files too",
              alternativeVariant: "destructive",
            })
          : (await dialogs.confirm(options))
            ? "confirm"
            : undefined;
  if (choice === undefined) return { edited: false };
  await threads
    .call(target, "threads.rollback", {
      threadId: input.threadId,
      beforeTurnId: input.turnId,
      ...(choice === "alternative" ? { restoreFiles: true } : {}),
    })
    .catch((failure: unknown) => {
      toasts?.show({
        type: "error",
        title: "Failed to revert thread state.",
        description: String((failure as Error).message ?? failure),
      });
      throw failure;
    });
  // The composer as it is now (the user may have switched threads meanwhile). The
  // message is never lost: past the room check, images that no longer fit stay in
  // the draft, and the composer's send refuses what is too much.
  const open = composer.current?.draftKey === key ? composer.current : undefined;
  if (open !== undefined) open.restore(message);
  else drafts.set(key, appendToDraft(drafts.get(key), message));
  return { edited: true };
}

/** A button of a message's hover row, as T3 draws them. */
function RowButton(props: {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick(): Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={busy || props.disabled === true}
            onClick={() => {
              setBusy(true);
              void props.onClick().finally(() => setBusy(false));
            }}
            size="xs"
            type="button"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Editing and regenerating (D223, D224): the commands `thread.edit-from-here`
 * and `thread.regenerate`, and the `chat.message.actions` buttons that run
 * them, beside the copy button.
 */
export function registerHistory(
  context: PluginContext,
  services: {
    readonly threads: ThreadsCatalog;
    readonly navigation: Navigation;
    readonly slots: SlotRegistry;
    readonly drafts: Drafts;
    readonly composer: ComposerHandle;
    readonly dialogs: Dialogs | undefined;
    readonly toasts: Toasts | undefined;
  },
) {
  const { threads, navigation, slots, drafts, composer, dialogs, toasts } = services;
  const failed = (title: string) => (failure: unknown) => {
    toasts?.show({
      type: "error",
      title,
      description: String((failure as Error).message ?? failure),
    });
    throw failure;
  };

  context.commands.register({
    name: "thread.edit-from-here",
    description:
      "Rewinds a thread to before one of its messages and puts the message's text and images back into the composer; nothing is sent. Asks first unless `confirmed`; `restoreFiles` puts its worktree's files back too",
    input: z.object({
      ...At,
      threadId: z.string(),
      turnId: z.string(),
      confirmed: z.boolean().optional(),
      restoreFiles: z.boolean().optional(),
    }),
    output: z.object({ edited: z.boolean() }),
    handler: (input) => editFromHere({ threads, drafts, composer, dialogs, toasts }, input),
  });

  context.commands.register({
    name: "thread.regenerate",
    description:
      "Runs a turn's message again (the latest turn by default), dropping the turn and every later one",
    input: z.object({ ...At, threadId: z.string(), turnId: z.string().optional() }),
    output: z.object({ turnId: z.string() }),
    handler: async (input) =>
      threads
        .call<{ turnId: string }>(targetOf(input), "threads.regenerate", {
          threadId: input.threadId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        })
        .catch(failed("Could not regenerate the response")),
  });

  context.commands.register({
    name: "thread.fork",
    description:
      "Forks a thread at a turn (its latest ended one by default) into a new thread of the same project, and opens it",
    input: z.object({
      ...At,
      threadId: z.string(),
      turnId: z.string().optional(),
      title: z.string().optional(),
    }),
    output: z.object({ threadId: z.string() }),
    handler: async (input) => {
      const target = targetOf(input);
      const fork = await threads
        .call<ThreadRecord>(target, "threads.fork", {
          threadId: input.threadId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          ...(input.title === undefined ? {} : { title: input.title }),
        })
        .catch(failed("Failed to fork this response."));
      navigation.navigate({ ...target, thread: fork.id });
      return { threadId: fork.id };
    },
  });

  context.commands.register({
    name: "thread.merge-back",
    description:
      "Merges a fork back into the thread it was forked from (its next message gives the agent the fork's result), and opens that thread",
    input: z.object({ ...At, threadId: z.string(), turnId: z.string().optional() }),
    output: z.object({ threadId: z.string() }),
    handler: async (input) => {
      const target = targetOf(input);
      const parent = await threads
        .call<ThreadRecord>(target, "threads.merge-back", {
          threadId: input.threadId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        })
        .catch(failed("Could not merge back"));
      navigation.navigate({ ...target, thread: parent.id });
      return { threadId: parent.id };
    },
  });

  /** A fork's header button (T3's ThreadRelationshipsControl merge-back action). */
  function MergeBack(props: ChatHeaderActionProps) {
    const catalog = useCatalog(threads, props.target);
    const thread = props.thread;
    if (thread?.forkedFrom === undefined) return null;
    const parent = catalog?.threads.find(
      (candidate) => candidate.id === thread.forkedFrom!.threadId,
    );
    // Whether the fork ran a turn. After a rollback in the fork the record may name a
    // copied turn; the node then refuses with T3's "Complete a run in this fork".
    const ran = thread.lastTurn !== undefined && thread.lastTurn.status !== "running";
    const label =
      parent === undefined ? "Merge back to source conversation" : `Merge back to ${parent.title}`;
    const tooltip = !ran
      ? "Complete a run in this fork before merging it back"
      : parent === undefined
        ? "Merge this conversation back into its source"
        : `Merge this conversation back into ${parent.title}`;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              disabled={!ran}
              onClick={() =>
                void context.commands
                  .execute("thread.merge-back", {
                    node: props.target.node,
                    ...(props.target.remote === undefined ? {} : { remote: props.target.remote }),
                    threadId: thread.id,
                  })
                  .catch(() => undefined)
              }
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <GitMergeIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
    );
  }
  context.subscriptions.add(
    slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
      id: "jhin.chat.merge-back",
      order: -10,
      component: MergeBack,
    }),
  );

  const run = (name: string, props: ChatMessageActionProps) =>
    context.commands
      .execute(name, {
        node: props.target.node,
        ...(props.target.remote === undefined ? {} : { remote: props.target.remote }),
        threadId: props.threadId,
        turnId: props.turnId,
      })
      .catch(() => undefined);

  context.subscriptions.add(
    slots.contribute<ChatMessageActionProps>("chat.message.actions", {
      id: "jhin.chat.message.copy",
      order: 0,
      component: (props) => (props.text === "" ? null : <MessageCopyButton text={props.text} />),
    }),
  );
  context.subscriptions.add(
    slots.contribute<ChatMessageActionProps>("chat.message.actions", {
      id: "jhin.chat.message.edit-from-here",
      order: 10,
      component: (props) =>
        props.role !== "user" ? null : (
          <RowButton
            disabled={props.running}
            icon={Undo2Icon}
            label="Edit from here"
            onClick={() => run("thread.edit-from-here", props)}
          />
        ),
    }),
  );
  context.subscriptions.add(
    slots.contribute<ChatMessageActionProps>("chat.message.actions", {
      id: "jhin.chat.message.regenerate",
      order: 20,
      component: (props) =>
        props.role !== "assistant" || !props.latest ? null : (
          <RowButton
            disabled={props.running}
            icon={RefreshCwIcon}
            label="Regenerate response"
            onClick={() => run("thread.regenerate", props)}
          />
        ),
    }),
  );
  context.subscriptions.add(
    slots.contribute<ChatMessageActionProps>("chat.message.actions", {
      id: "jhin.chat.message.fork",
      order: 30,
      component: (props) =>
        props.role !== "assistant" || (props.latest && props.running) ? null : (
          <RowButton
            icon={GitForkIcon}
            label="Fork from this response"
            onClick={() => run("thread.fork", props)}
          />
        ),
    }),
  );
}
