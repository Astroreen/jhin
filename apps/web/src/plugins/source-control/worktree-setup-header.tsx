// When the worktree setup card shows follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/MessagesTimeline.logic.ts (under the first message, collapsed to
// one row once the agent has started and the setup is over). The card is worktree-setup.tsx, a
// chunk of its own (D1595): most threads never have a setup. MessagesTimeline.tsx's Retry of a
// failed workspace preparation is here too.
import type { ChatTurnFooterProps, ChatTurnHeaderProps, NodeTarget } from "@jhin/client-api";
import {
  WORKTREE_SETUP_CHANGED,
  worktreeSetupAgentStarted,
  worktreeSetupStream,
  type WorktreeSetupSnapshot,
} from "@jhin/source-control-api";
import { Button } from "@jhin/ui";
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import type { SourceControlServices } from "./services.ts";

const WorktreeSetupCard = lazyChunk(
  () => import("./worktree-setup.tsx").then((module) => module.WorktreeSetupCard),
  {
    loading: () => null,
    failed: (_props, retry) => (
      <ChunkFailed retry={retry}>Couldn't load the worktree setup.</ChunkFailed>
    ),
  },
);

/** The latest snapshot of a thread's setup, followed on the node's live stream. */
function useWorktreeSetup(
  services: SourceControlServices,
  target: NodeTarget,
  threadId: string,
): WorktreeSetupSnapshot | null {
  const [snapshot, setSnapshot] = useState<WorktreeSetupSnapshot | null>(null);
  const connection = services.connections.get(target.node);
  const client = connection?.state === "open" ? connection.client : undefined;
  useEffect(() => {
    setSnapshot(null);
    // A mesh member's setup streams are not relayed: its threads show no card.
    if (client === undefined || target.remote !== undefined) return;
    const subscription = client.subscribe(
      worktreeSetupStream(threadId),
      { onError: () => undefined },
      (event) => {
        if (event.type !== WORKTREE_SETUP_CHANGED) return;
        const next = event.payload as WorktreeSetupSnapshot;
        // A late older snapshot never replaces a newer one.
        setSnapshot((current) =>
          current !== null && current.sequence > next.sequence ? current : next,
        );
      },
    );
    // The setup as the node has it now: a finished one is kept with its thread, also
    // across a restart, when nothing comes on the stream (D1479).
    let current = true;
    void client
      .call<WorktreeSetupSnapshot | null>("git.worktree.setup.get", { threadId })
      .then((kept) => {
        if (!current || kept === null) return;
        setSnapshot((shown) => (shown !== null && shown.sequence >= kept.sequence ? shown : kept));
      })
      .catch(() => undefined);
    return () => {
      current = false;
      subscription.dispose();
    };
  }, [client, target.remote, threadId]);
  return snapshot;
}

/** The `chat.turn.header` contribution: the setup card under a thread's first message. */
export function createWorktreeSetupHeader(services: SourceControlServices) {
  return function WorktreeSetupHeader({ target, thread, first }: ChatTurnHeaderProps) {
    const snapshot = useWorktreeSetup(services, target, thread.id);
    if (!first || snapshot === null) return null;
    const terminalId = snapshot.setupScript?.terminalId;
    const embedded = worktreeSetupAgentStarted(snapshot) && snapshot.phase !== "running";
    const cancel = (workLocally: boolean) => {
      void services.threads
        .call(target, "git.worktree.setup.cancel", {
          threadId: thread.id,
          ...(workLocally ? { workLocally } : {}),
        })
        .catch((error: unknown) =>
          services.toasts?.show({
            type: "error",
            title: "Could not cancel the worktree setup",
            description: (error as Error).message,
          }),
        );
    };
    return (
      <WorktreeSetupCard
        embedded={embedded}
        onCancel={embedded ? null : () => cancel(false)}
        onWorkLocally={embedded ? null : () => cancel(true)}
        onOpenTerminal={
          terminalId === undefined ||
          !services.context.commands.list().some((command) => command.name === "terminal.reveal")
            ? null
            : () =>
                void services.context.commands.execute("terminal.reveal", {
                  node: target.node,
                  ...(target.remote === undefined ? {} : { remote: target.remote }),
                  threadId: thread.id,
                  terminalId,
                })
        }
        snapshot={snapshot}
      />
    );
  };
}

/**
 * T3's Retry under a first turn that failed because its workspace could not be
 * prepared (D1478): the setup again, then the turn's message again.
 */
export function createWorkspaceRetryFooter(services: SourceControlServices) {
  return function WorkspaceRetry({ target, thread, turnId, state, latest }: ChatTurnFooterProps) {
    const [pending, setPending] = useState(false);
    if (
      !latest ||
      state !== "failed" ||
      thread.lastTurn?.turnId !== turnId ||
      thread.lastTurn.failure?.class !== "workspace_preparation"
    ) {
      return null;
    }
    return (
      <div className="pb-1">
        <Button
          disabled={pending}
          onClick={() => {
            // One retry per failure: a second click lands once the setup runs again.
            setPending(true);
            void services.threads
              .call(target, "git.worktree.setup.retry", { threadId: thread.id })
              .catch((error: unknown) =>
                services.toasts?.show({
                  type: "error",
                  title: "Could not retry the worktree setup",
                  description: (error as Error).message,
                }),
              )
              .finally(() => setPending(false));
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          <RotateCcwIcon aria-hidden />
          Retry
        </Button>
      </div>
    );
  };
}
