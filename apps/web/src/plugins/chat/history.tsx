// "Edit from here" follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/MessagesTimeline.tsx (RevertUserMessageButton, the hover row of a
// message), ChatOverlayHosts.tsx (the confirmation) and ChatView.tsx (rewindToMessage).
import type { TurnAttachment } from "@jhin/agent-api";
import type { ChatMessageActionProps, NodeTarget, ThreadsCatalog } from "@jhin/client-api";
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
import { RefreshCwIcon, Undo2Icon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import {
  appendToDraft,
  restoreIntoDraft,
  threadDraftKey,
  type Drafts,
} from "../../lib/composer.ts";
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
    readonly dialogs: Pick<Dialogs, "confirm"> | undefined;
    readonly toasts: Pick<Toasts, "show"> | undefined;
  },
  input: {
    readonly node: string;
    readonly remote?: string | undefined;
    readonly threadId: string;
    readonly turnId: string;
    readonly confirmed?: boolean | undefined;
  },
): Promise<{ edited: boolean }> {
  const { threads, drafts, composer, dialogs, toasts } = services;
  const target = targetOf(input);
  const key = threadDraftKey(target, input.threadId);
  const turn = await threads.call<{
    input: { text: string; attachments?: TurnAttachment[] };
  }>(target, "threads.turn", { threadId: input.threadId, turnId: input.turnId });
  const message = { prompt: turn.input.text, attachments: turn.input.attachments ?? [] };
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
  const confirmed =
    input.confirmed === true ||
    (dialogs !== undefined &&
      (await dialogs.confirm({
        title: "Edit from here?",
        description:
          "Rewind chat to before this message. Your prompt and attachments return to the composer.",
        confirmLabel: "Revert and keep changes",
      })));
  if (!confirmed) return { edited: false };
  await threads
    .call(target, "threads.rollback", {
      threadId: input.threadId,
      beforeTurnId: input.turnId,
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
    readonly slots: SlotRegistry;
    readonly drafts: Drafts;
    readonly composer: ComposerHandle;
    readonly dialogs: Dialogs | undefined;
    readonly toasts: Toasts | undefined;
  },
) {
  const { threads, slots, drafts, composer, dialogs, toasts } = services;
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
      "Rewinds a thread to before one of its messages and puts the message's text and images back into the composer; nothing is sent. Asks first unless `confirmed`",
    input: z.object({
      ...At,
      threadId: z.string(),
      turnId: z.string(),
      confirmed: z.boolean().optional(),
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
}
