// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/hooks/useProactivePanels.ts and its helpers in
// apps/web/src/components/ChatView.logic.ts (observeProactivePanelUserChoice,
// shouldOpenProactivePullRequest, shouldOpenProactiveTurnDiff, resolveProactiveTurnDiffAction).
//
// The right panel opening itself on what is new for the thread on screen (source-control.md D1426).
import { rightPanelPlaceKey, type ChatHeaderActionProps, type RightPanel } from "@jhin/client-api";
import type { TurnCheckpoint } from "@jhin/source-control-api";
import { useEffect, useRef } from "react";

import { useConfig } from "../../lib/hooks.ts";
import { DIFF_SECTION, type DiffSettings } from "../../lib/settings.ts";
import { selectionKey } from "./diff/scopes.ts";
import {
  DIFF_PANEL,
  PULL_REQUESTS_PANEL,
  useSourceControl,
  type SourceControlServices,
} from "./services.ts";

/** T3's ProactivePanelObservation: what the thread on screen had when it was last looked at. */
export interface ProactiveObservation {
  readonly threadKey: string;
  /** The turn running when last decided; `undefined` until a first decision (T3's first entry). */
  readonly runningTurnId: string | null | undefined;
  /** The thread's linked pull requests when last decided. */
  readonly targetKey: string | null | undefined;
  /** The turn the user's choices count from. */
  readonly userActionTurnId: string | null;
  /** The user's revision of the panel when that turn began or the thread came on screen. */
  readonly userActionRevision: number;
}

/** T3's `observeProactivePanelUserChoice`: a new thread or a new turn reads the revision anew. */
function observeUserChoice(
  previous: ProactiveObservation | undefined,
  input: {
    readonly threadKey: string;
    readonly runningTurnId: string | null;
    readonly userActionRevision: number;
  },
): ProactiveObservation {
  const sameThread = previous?.threadKey === input.threadKey;
  const newTurn =
    sameThread && input.runningTurnId !== null && input.runningTurnId !== previous.userActionTurnId;
  return {
    threadKey: input.threadKey,
    runningTurnId: sameThread ? previous.runningTurnId : undefined,
    targetKey: sameThread ? previous.targetKey : undefined,
    userActionTurnId: input.runningTurnId ?? (sameThread ? previous.userActionTurnId : null),
    userActionRevision:
      !sameThread || newTurn ? input.userActionRevision : previous.userActionRevision,
  };
}

/**
 * T3's `resolveProactiveTurnDiffAction`: a turn's changes worth showing, or `defer` while its
 * checkpoint or the repository is not known yet.
 */
export function turnDiffAction(input: {
  readonly checkpoint: TurnCheckpoint | undefined;
  readonly isGitRepo: boolean | undefined;
  readonly activeKind: string | undefined;
}): "defer" | "ignore" | "open" {
  // An open diff already shows the work; reopening it would reset the chosen scope.
  if (input.activeKind === DIFF_PANEL || input.activeKind === PULL_REQUESTS_PANEL) return "ignore";
  if (input.checkpoint === undefined || input.isGitRepo === undefined) return "defer";
  const { checkpoint } = input;
  if (!input.isGitRepo || checkpoint.status !== "ready" || checkpoint.fileCount === 0) {
    return "ignore";
  }
  return checkpoint.fileCount >= 3 || checkpoint.insertions + checkpoint.deletions >= 50
    ? "open"
    : "ignore";
}

export interface ProactiveInput {
  readonly threadKey: string;
  readonly enabled: boolean;
  readonly userActionRevision: number;
  /** The thread's latest turn. */
  readonly latestTurn: { readonly turnId: string; readonly status: string } | undefined;
  /** Its linked pull requests' keys, `null` with none. */
  readonly pullRequestsKey: string | null;
  /** Its latest turn's checkpoint, once the node has it. */
  readonly checkpoint: TurnCheckpoint | undefined;
  readonly isGitRepo: boolean | undefined;
  /** The kind of the surface the panel shows, if it is open. */
  readonly activeKind: string | undefined;
}

/**
 * T3's useProactivePanels as one decision: the surface to open, if any, and what to remember.
 * A thread coming on screen counts as new (T3's first entry); what is still loading is decided
 * once it loads.
 */
export function decideProactivePanels(
  previous: ProactiveObservation | undefined,
  input: ProactiveInput,
): { observation: ProactiveObservation; open: "pull-requests" | "diff" | undefined } {
  const turn = input.latestTurn;
  const active = turn?.status === "running" || turn?.status === "waiting";
  const runningTurnId = active ? turn.turnId : null;
  const observation = observeUserChoice(previous, {
    threadKey: input.threadKey,
    runningTurnId,
    userActionRevision: input.userActionRevision,
  });
  // T3's shouldOpenProactivePullRequest.
  const linked =
    input.enabled &&
    input.pullRequestsKey !== null &&
    input.pullRequestsKey !== observation.targetKey;
  // T3's shouldOpenProactiveTurnDiff: the turn seen running ended, or one ended before entry.
  const settledTurnId = turn !== undefined && !active ? turn.turnId : null;
  const completed =
    runningTurnId === null &&
    turn?.status === "completed" &&
    settledTurnId !== null &&
    (observation.runningTurnId === undefined || settledTurnId === observation.runningTurnId);
  const eligible = input.enabled && completed && input.pullRequestsKey === null;
  const action = eligible
    ? turnDiffAction({
        checkpoint: input.checkpoint?.turnId === settledTurnId ? input.checkpoint : undefined,
        isGitRepo: input.isGitRepo,
        activeKind: input.activeKind,
      })
    : "ignore";
  return {
    observation: {
      ...observation,
      targetKey: input.pullRequestsKey,
      // A deferred turn stays eligible while its checkpoint or the repository loads.
      runningTurnId: action === "defer" ? observation.runningTurnId : runningTurnId,
    },
    open: linked ? "pull-requests" : action === "open" ? "diff" : undefined,
  };
}

/** A component of the chat header that only watches (T3's useProactivePanels). */
export function createProactivePanels(services: SourceControlServices, panel: RightPanel) {
  const { store, context, selections } = services;
  return function ProactivePanels({ target, thread }: ChatHeaderActionProps) {
    const settings = useConfig<DiffSettings>(context, DIFF_SECTION);
    const view = useSourceControl(store, target);
    const observation = useRef<ProactiveObservation | undefined>(undefined);
    const threadId = thread?.id;
    const links = threadId === undefined ? [] : (view.links.get(threadId) ?? []);
    const linksKey = links
      .map((link) => link.key)
      .toSorted()
      .join(" ");
    const checkpoint = threadId === undefined ? undefined : view.checkpoints.get(threadId);
    const latestTurn = thread?.lastTurn;
    const projectId = thread?.projectId;
    const repository = projectId === undefined ? undefined : view.projects.get(projectId)?.isRepo;
    const placeKey = threadId === undefined ? undefined : rightPanelPlaceKey({ target, threadId });

    useEffect(() => {
      if (threadId === undefined || projectId === undefined || placeKey === undefined) {
        observation.current = undefined;
        return;
      }
      const place = { target, threadId };
      const state = panel.state(place);
      const decision = decideProactivePanels(observation.current, {
        threadKey: placeKey,
        enabled: settings.proactivePanels,
        userActionRevision: panel.revision(place),
        latestTurn,
        pullRequestsKey: linksKey === "" ? null : linksKey,
        checkpoint,
        isGitRepo: repository,
        activeKind: state.open
          ? state.surfaces.find((surface) => surface.id === state.activeId)?.kind
          : undefined,
      });
      observation.current = decision.observation;
      const revision = decision.observation.userActionRevision;
      if (decision.open === "pull-requests") {
        panel.openProactive(place, { kind: PULL_REQUESTS_PANEL }, revision);
      } else if (
        decision.open === "diff" &&
        panel.openProactive(place, { kind: DIFF_PANEL }, revision)
      ) {
        // T3's selectGitScope(…, "branch"): "Changes", the first scope.
        selections.update(selectionKey({ target, projectId, threadId }), {
          value: undefined,
          filePath: undefined,
          reveal: undefined,
        });
      }
    }, [
      placeKey,
      projectId,
      settings.proactivePanels,
      latestTurn?.turnId,
      latestTurn?.status,
      linksKey,
      checkpoint?.turnId,
      checkpoint?.status,
      repository,
    ]);
    return null;
  };
}
