// When the worktree setup card shows follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/MessagesTimeline.logic.ts (under the first message, collapsed to
// one row once the agent has started and the setup is over). The card is worktree-setup.tsx, a
// chunk of its own (D1595): most threads never have a setup.
import type { ChatTurnHeaderProps, NodeTarget } from "@jhin/client-api";
import {
  WORKTREE_SETUP_CHANGED,
  worktreeSetupAgentStarted,
  worktreeSetupStream,
  type WorktreeSetupSnapshot,
} from "@jhin/source-control-api";
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
    return () => subscription.dispose();
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
    return (
      <WorktreeSetupCard
        embedded={embedded}
        onCancel={
          embedded
            ? null
            : () => {
                void services.threads
                  .call(target, "git.worktree.setup.cancel", { threadId: thread.id })
                  .catch((error: unknown) =>
                    services.toasts?.show({
                      type: "error",
                      title: "Could not cancel the worktree setup",
                      description: (error as Error).message,
                    }),
                  );
              }
        }
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
