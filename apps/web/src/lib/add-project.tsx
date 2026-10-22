import {
  type Connections,
  type Navigation,
  type NodeMachines,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";
import { Dialog, DialogPopup, type Toasts } from "@jhin/ui";
import { useSyncExternalStore } from "react";

import { ChunkFailed, lazyChunk } from "./lazy-chunk.tsx";

import type { ShownNode } from "./nodes.ts";

/** Who asked for the dialog; one at a time. */
export function createAddProjectRequests() {
  let target: NodeTarget | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    open(next: NodeTarget) {
      target = next;
      changed();
    },
    close() {
      target = undefined;
      changed();
    },
    current: () => target,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type AddProjectRequests = ReturnType<typeof createAddProjectRequests>;

/** The nodes the client shows, to pick where the project goes (`createShownNodes`). */
export interface NodeChoices {
  snapshot(): readonly ShownNode[];
  subscribe(listener: () => void): Disposable;
}

// The form is a chunk of its own, loaded when the dialog first opens (D440, D1041).
const LazyAddProjectForm = lazyChunk(
  () => import("./add-project-form.tsx").then((module) => module.AddProjectForm),
  {
    loading: () => null,
    failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load this dialog.</ChunkFailed>,
  },
);

export function AddProjectDialog(props: {
  requests: AddProjectRequests;
  /** With several, the dialog asks on which node (T3 Code asks for the environment). */
  nodes?: NodeChoices;
  /** Each node of the picker shows its machine icon. */
  machines?: NodeMachines | undefined;
  connections: Connections;
  navigation: Navigation;
  threads: ThreadsCatalog;
  toasts: Toasts | undefined;
}) {
  const { requests } = props;
  const target = useSyncExternalStore(requests.subscribe, requests.current);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) requests.close();
      }}
      open={target !== undefined}
    >
      {target === undefined ? null : (
        <DialogPopup>
          <LazyAddProjectForm
            key={`${target.node}|${target.remote ?? ""}`}
            {...props}
            target={target}
          />
        </DialogPopup>
      )}
    </Dialog>
  );
}
