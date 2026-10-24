// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/hooks/useProactivePanels.ts and its helpers in
// apps/web/src/components/ChatView.logic.ts (observeProactivePanelUserChoice,
// shouldOpenProactivePullRequest, resolveProactiveTurnDiffAction).
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

/** T3's `resolveProactiveTurnDiffAction`: a turn's changes worth showing. */
export function turnDiffWorthOpening(checkpoint: TurnCheckpoint): boolean {
  if (checkpoint.status !== "ready" || checkpoint.fileCount === 0) return false;
  return checkpoint.fileCount >= 3 || checkpoint.insertions + checkpoint.deletions >= 50;
}

/** What one thread on screen had when it was last looked at. */
interface Observation {
  readonly place: string;
  /** The user's revision of the panel when the thread came on screen or its turn began. */
  revision: number;
  running: boolean;
  links: string;
  turnId: string | undefined;
}

/** A component of the chat header that only watches (T3's useProactivePanels). */
export function createProactivePanels(services: SourceControlServices, panel: RightPanel) {
  const { store, context, selections } = services;
  return function ProactivePanels({ target, thread }: ChatHeaderActionProps) {
    const settings = useConfig<DiffSettings>(context, DIFF_SECTION);
    const view = useSourceControl(store, target);
    const observation = useRef<Observation | undefined>(undefined);
    const threadId = thread?.id;
    const links = threadId === undefined ? [] : (view.links.get(threadId) ?? []);
    const linksKey = links
      .map((link) => link.key)
      .toSorted()
      .join(" ");
    const checkpoint = threadId === undefined ? undefined : view.checkpoints.get(threadId);
    const running = thread?.lastTurn?.status === "running";
    const projectId = thread?.projectId;
    const repository = projectId === undefined ? undefined : view.projects.get(projectId)?.isRepo;

    useEffect(() => {
      if (threadId === undefined || projectId === undefined) return;
      const place = { target, threadId };
      const key = rightPanelPlaceKey(place);
      const previous = observation.current;
      if (previous?.place !== key) {
        // A thread just on screen: what it already has is not news.
        observation.current = {
          place: key,
          revision: panel.revision(place),
          running,
          links: linksKey,
          turnId: checkpoint?.turnId,
        };
        return;
      }
      // A new turn: the user's choices count from its start (observeProactivePanelUserChoice).
      if (running && !previous.running) previous.revision = panel.revision(place);
      previous.running = running;
      const linked = linksKey !== "" && linksKey !== previous.links;
      previous.links = linksKey;
      const finished =
        !running && checkpoint !== undefined && checkpoint.turnId !== previous.turnId;
      if (finished) previous.turnId = checkpoint.turnId;
      if (!settings.proactivePanels) return;
      const state = panel.state(place);
      const active = state.open
        ? state.surfaces.find((surface) => surface.id === state.activeId)?.kind
        : undefined;
      if (linked) {
        panel.openProactive(place, { kind: PULL_REQUESTS_PANEL }, previous.revision);
        return;
      }
      if (
        !finished ||
        links.length > 0 ||
        repository !== true ||
        active === DIFF_PANEL ||
        active === PULL_REQUESTS_PANEL ||
        !turnDiffWorthOpening(checkpoint)
      ) {
        return;
      }
      if (panel.revision(place) !== previous.revision) return;
      // T3's selectGitScope(…, "branch"): "Changes", the first scope.
      selections.update(selectionKey({ target, projectId, threadId }), {
        value: undefined,
        filePath: undefined,
        reveal: undefined,
      });
      panel.openProactive(place, { kind: DIFF_PANEL }, previous.revision);
    }, [threadId, projectId, running, linksKey, checkpoint?.turnId, checkpoint?.status]);
    return null;
  };
}
