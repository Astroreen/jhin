import {
  targetKey,
  type Connections,
  type Navigation,
  type NodeMachines,
  type NodeTarget,
  type ProjectRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  ScrollArea,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Spinner,
  cn,
  type Toasts,
} from "@jhin/ui";
import { CornerLeftUpIcon, FolderGit2Icon, FolderIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { MachineIcon } from "./machine-icon.tsx";
import { useMachineKind } from "./machines.ts";
import type { ShownNode } from "./nodes.ts";

interface Listing {
  readonly path: string;
  readonly parent?: string;
  readonly home: string;
  readonly entries: readonly {
    readonly name: string;
    readonly path: string;
    readonly git: boolean;
  }[];
}

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

const noNodes: NodeChoices = { snapshot: () => [], subscribe: () => ({ dispose() {} }) };
const subscribers = new WeakMap<NodeChoices, (listener: () => void) => () => void>();
const subscriberOf = (nodes: NodeChoices) => {
  let subscribe = subscribers.get(nodes);
  if (subscribe === undefined) {
    subscribe = (listener) => {
      const subscription = nodes.subscribe(listener);
      return () => subscription.dispose();
    };
    subscribers.set(nodes, subscribe);
  }
  return subscribe;
};

const separator = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");

/** The folder whose children complete `path`, and the typed beginning of the child's name. */
function splitPath(path: string): { dir: string; prefix: string } {
  const sep = separator(path);
  const index = path.lastIndexOf(sep);
  if (index < 0) return { dir: "", prefix: path };
  return { dir: path.slice(0, index) || sep, prefix: path.slice(index + 1) };
}

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
          <AddProjectForm
            key={`${target.node}|${target.remote ?? ""}`}
            {...props}
            target={target}
          />
        </DialogPopup>
      )}
    </Dialog>
  );
}

/** A node of the picker: its machine icon, then its name. */
function NodeChoice(props: {
  machines: NodeMachines | undefined;
  target: NodeTarget;
  label: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <MachineIcon
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
        kind={useMachineKind(props.machines, props.target)}
      />
      <span className="truncate">{props.label}</span>
    </span>
  );
}

function AddProjectForm(props: {
  requests: AddProjectRequests;
  nodes?: NodeChoices;
  machines?: NodeMachines | undefined;
  target: NodeTarget;
  connections: Connections;
  navigation: Navigation;
  threads: ThreadsCatalog;
  toasts: Toasts | undefined;
}) {
  const { target, threads } = props;
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [listing, setListing] = useState<Listing | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const nodes = props.nodes ?? noNodes;
  const choices = useSyncExternalStore(subscriberOf(nodes), nodes.snapshot).filter(
    (node) => node.state === "open",
  );
  const chosen = choices.find((node) => targetKey(node.target) === targetKey(target));
  const label =
    chosen?.label ??
    (target.remote === undefined
      ? (props.connections.get(target.node)?.label ?? target.node)
      : target.remote);

  // The home folder first, then the folder the typed path is in.
  const { dir, prefix } = splitPath(path);
  useEffect(() => {
    let current = true;
    void threads
      .call<Listing>(target, "projects.browse", dir === "" ? {} : { path: dir })
      .then((next) => {
        if (!current) return;
        setListing(next);
        if (path === "") setPath(`${next.path}${separator(next.path)}`);
      })
      .catch(() => {
        if (current) setListing(undefined);
      });
    return () => {
      current = false;
    };
  }, [threads, target, dir]);

  const suggestions = (listing?.entries ?? []).filter((entry) =>
    entry.name.toLowerCase().startsWith(prefix.toLowerCase()),
  );
  const choose = (entryPath: string) => {
    setPath(`${entryPath}${separator(entryPath)}`);
    setHighlight(0);
  };

  const submit = async () => {
    const trimmed = path.trim().replace(/[\\/]+$/, "") || path.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(undefined);
    try {
      const project = await threads.call<ProjectRecord>(target, "projects.create", {
        path: trimmed,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
      });
      props.requests.close();
      props.toasts?.show({ type: "success", title: "Project added", description: project.name });
      props.navigation.navigate({
        node: target.node,
        ...(target.remote === undefined ? {} : { remote: target.remote }),
        project: project.id,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="Add project"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>
          A folder on {label}. Its threads run there, with the folder as their working directory.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-2">
          {choices.length > 1 ? (
            <Select
              onValueChange={(value) => {
                const next = choices.find((node) => targetKey(node.target) === value);
                if (next !== undefined && targetKey(next.target) !== targetKey(target))
                  props.requests.open(next.target);
              }}
              value={targetKey(target)}
            >
              <SelectTrigger aria-label="Node" className="w-full">
                <SelectValue>
                  <NodeChoice label={label} machines={props.machines} target={target} />
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {choices.map((node) => (
                  <SelectItem key={targetKey(node.target)} value={targetKey(node.target)}>
                    <NodeChoice label={node.label} machines={props.machines} target={node.target} />
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Input
            aria-label="Project folder"
            autoFocus
            className="font-mono"
            onChange={(event) => {
              setPath(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight((index) => Math.min(index + 1, suggestions.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((index) => Math.max(index - 1, 0));
              } else if (event.key === "Tab" && suggestions[highlight] !== undefined) {
                event.preventDefault();
                choose(suggestions[highlight]!.path);
              }
            }}
            placeholder="~/projects/my-app"
            value={path}
          />
          <ScrollArea className="max-h-56 rounded-lg border border-border/70" scrollFade>
            <ul aria-label="Folders" className="flex flex-col p-1">
              {listing?.parent !== undefined && prefix === "" ? (
                <li>
                  <button
                    className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
                    onClick={() => choose(listing.parent!)}
                    type="button"
                  >
                    <CornerLeftUpIcon className="size-4 shrink-0" />
                    ..
                  </button>
                </li>
              ) : null}
              {listing === undefined ? (
                <li className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                  <Spinner size="sm" />
                  Reading folders…
                </li>
              ) : suggestions.length === 0 ? (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">No folders here.</li>
              ) : (
                suggestions.map((entry, index) => (
                  <li key={entry.path}>
                    <button
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                        index === highlight && "bg-accent",
                      )}
                      onClick={() => choose(entry.path)}
                      type="button"
                    >
                      {entry.git ? (
                        <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 truncate">{entry.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </ScrollArea>
          <Input
            aria-label="Project name"
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (the folder's name by default)"
            value={name}
          />
          {error === undefined ? null : (
            <p className="text-destructive-foreground text-xs" role="alert">
              {error}
            </p>
          )}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button onClick={() => props.requests.close()} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={busy || path.trim() === ""} type="submit">
          {busy ? <Spinner size="sm" /> : null}
          Add project
        </Button>
      </DialogFooter>
    </form>
  );
}
