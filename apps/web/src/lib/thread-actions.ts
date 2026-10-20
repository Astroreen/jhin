// The actions and their wording follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/hooks/useThreadActionMenu.ts and apps/web/src/components/Sidebar.tsx.
import type { TurnAttachment } from "@jhin/agent-api";
import type {
  MeshMembership,
  Navigation,
  NodeTarget,
  ProjectRecord,
  ThreadRecord,
  ThreadsCatalog,
  ThreadVisits,
} from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { copyText, type Dialogs, type Toasts } from "@jhin/ui";

import { CHAT_SECTION, ChatSettings, readSection } from "./settings.ts";

export interface ThreadActionServices {
  readonly context: PluginContext;
  /** Absent without a `client.visits` provider: nothing then shows as unread. */
  readonly visits: ThreadVisits | undefined;
  readonly threads: ThreadsCatalog;
  readonly navigation: Navigation;
  readonly mesh: MeshMembership;
  readonly toasts: Toasts | undefined;
  readonly dialogs: Dialogs | undefined;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The node id of a target: the remote's, or the connection's own from its mesh. */
function nodeIdOf(mesh: MeshMembership, target: NodeTarget): string | undefined {
  if (target.remote !== undefined) return target.remote;
  return mesh.members(target.node)?.find((member) => member.self)?.nodeId;
}

/**
 * Errors after which a message may still have reached the node, because the
 * connection or the mesh dropped the call: its turn may be running.
 */
const UNCERTAIN = new Set(["DISCONNECTED", "MESH_TIMEOUT", "NODE_UNREACHABLE"]);

/**
 * Whether a failed `startThread` may have left its thread on the node: only a
 * creation whose answer the connection lost. Then the next try asks for the
 * same id; after any other failure the id is spent (its thread deleted, which
 * takes the id for good, D207) or was never used.
 */
export const threadMayExist = (error: unknown) =>
  UNCERTAIN.has(String((error as { code?: unknown } | null)?.code));

/**
 * Creates a thread and sends its first message. A creation whose answer the
 * connection dropped is asked again with the same thread id, so it leaves no
 * second thread. A thread whose first message
 * the node refused is deleted again, so a failed start leaves no empty thread
 * behind (unless the node is out of reach for that too). When the message may
 * have reached the node all the same, the thread stays: the result has its id
 * and what went wrong.
 */
export async function startThread(
  threads: Pick<ThreadsCatalog, "call">,
  target: NodeTarget,
  first: {
    readonly projectId: string;
    /** Instead of the title the first message gives it. */
    readonly title?: string;
    readonly text: string;
    readonly attachments: readonly TurnAttachment[];
    /** The agent, model and modes the thread runs with. */
    readonly selection: {
      readonly agentId?: string;
      readonly model?: string;
      readonly runtimeMode?: string;
      readonly interactionMode?: string;
    };
  },
  /** The new thread's id; chosen here by default, so asking again makes no second thread. */
  threadId: string = crypto.randomUUID(),
): Promise<{ readonly threadId: string; readonly uncertain?: Error }> {
  const create = () =>
    threads.call<ThreadRecord>(target, "threads.create", {
      threadId,
      projectId: first.projectId,
      ...(first.title === undefined ? {} : { title: first.title }),
      ...first.selection,
    });
  let thread: ThreadRecord;
  try {
    thread = await create();
  } catch (error) {
    if (!threadMayExist(error)) throw error;
    // The answer was lost, not necessarily the thread: the node returns the
    // thread it made for this id, or makes it now (D207).
    thread = await create();
  }
  try {
    await threads.call(target, "threads.send", {
      threadId: thread.id,
      text: first.text,
      ...(first.attachments.length === 0 ? {} : { attachments: first.attachments }),
      ...first.selection,
    });
  } catch (error) {
    if (UNCERTAIN.has(String((error as { code?: unknown } | null)?.code))) {
      return { threadId: thread.id, uncertain: error as Error };
    }
    // The send's error is the one to show; a failed clean-up adds nothing to it.
    await threads.call(target, "threads.delete", { threadId: thread.id }).catch(() => undefined);
    throw error;
  }
  return { threadId: thread.id };
}

/** A change to where the sidebar keeps a thread, as the threads plugin's commands take it. */
export type ThreadArrangement =
  | { readonly method: "settle" | "unsettle" | "unpin" | "unsnooze" }
  | { readonly method: "pin"; readonly orderKey?: string }
  | { readonly method: "snooze"; readonly until: string }
  | { readonly method: "set-auto-settle"; readonly enabled: boolean }
  | { readonly method: "reorder"; readonly list: "pinned" | "active"; readonly orderKey: string };

/** What can be done to a thread from its row, its header or the command palette. */
export function threadActions(services: ThreadActionServices) {
  const { threads, toasts, dialogs, navigation, context } = services;
  const fail = (title: string, error: unknown) =>
    toasts?.show({ type: "error", title, description: errorText(error) });
  const settings = () => readSection(context, CHAT_SECTION, ChatSettings);
  const copy = (text: string, title: string) =>
    void copyText(text).then(
      () => toasts?.show({ type: "success", title, timeout: 1500 }),
      (error: unknown) => fail("Could not copy", error),
    );
  /** Leaves a thread that goes away, if it is the open one. */
  const leave = (target: NodeTarget, thread: ThreadRecord) => {
    const route = navigation.current();
    if (
      route.node === target.node &&
      route.remote === target.remote &&
      route.thread === thread.id
    ) {
      navigation.navigate({
        node: target.node,
        ...(target.remote === undefined ? {} : { remote: target.remote }),
        project: thread.projectId,
      });
    }
  };

  /**
   * Settles, un-settles, pins, unpins, snoozes or wakes a thread on its node
   * (D75–D77); true when the node did it, else the failure shows as a toast.
   */
  const arrange = async (
    target: NodeTarget,
    thread: ThreadRecord,
    change: ThreadArrangement,
    failure: string,
  ): Promise<boolean> => {
    const { method, ...input } = change;
    try {
      await threads.call(target, `threads.${method}`, { threadId: thread.id, ...input });
      return true;
    } catch (error) {
      fail(failure, error);
      return false;
    }
  };

  return {
    /** True when renamed; an empty or unchanged title does nothing. */
    async rename(target: NodeTarget, thread: ThreadRecord, title: string): Promise<boolean> {
      const trimmed = title.trim();
      if (trimmed === "") {
        toasts?.show({ type: "warning", title: "Thread title cannot be empty" });
        return false;
      }
      if (trimmed === thread.title) return false;
      try {
        await threads.call(target, "threads.update", { threadId: thread.id, title: trimmed });
        return true;
      } catch (error) {
        fail("Failed to rename thread", error);
        return false;
      }
    },
    /** Archives a thread after asking when the settings say so; true once it is archived. */
    async archive(target: NodeTarget, thread: ThreadRecord): Promise<boolean> {
      if (
        settings().confirmArchive &&
        dialogs !== undefined &&
        !(await dialogs.confirm({
          title: `Archive thread "${thread.title}"?`,
          description: "It leaves the sidebar; Settings → Archived threads brings it back.",
          confirmLabel: "Archive",
        }))
      ) {
        return false;
      }
      try {
        await threads.call(target, "threads.archive", { threadId: thread.id });
        leave(target, thread);
        return true;
      } catch (error) {
        fail("Failed to archive thread", error);
        return false;
      }
    },
    async unarchive(target: NodeTarget, thread: ThreadRecord): Promise<void> {
      try {
        await threads.call(target, "threads.unarchive", { threadId: thread.id });
      } catch (error) {
        fail("Failed to unarchive thread", error);
      }
    },
    async remove(target: NodeTarget, thread: ThreadRecord): Promise<void> {
      if (
        settings().confirmDelete &&
        dialogs !== undefined &&
        !(await dialogs.confirm({
          title: `Delete thread "${thread.title}"?`,
          description: "This permanently clears conversation history for this thread.",
          confirmLabel: "Delete",
          variant: "destructive",
        }))
      ) {
        return;
      }
      try {
        await threads.call(target, "threads.delete", { threadId: thread.id });
        leave(target, thread);
      } catch (error) {
        fail("Failed to delete thread", error);
      }
    },
    arrange,
    /** Unpins a thread, after asking when the settings say so (T3's confirmThreadUnpin). */
    async unpin(target: NodeTarget, thread: ThreadRecord): Promise<boolean> {
      if (
        settings().confirmUnpin &&
        dialogs !== undefined &&
        !(await dialogs.confirm({
          title: `Unpin thread "${thread.title}"?`,
          description: "This will move the thread out of your pinned section.",
          confirmLabel: "Unpin",
        }))
      ) {
        return false;
      }
      return arrange(target, thread, { method: "unpin" }, "Failed to unpin thread");
    },
    markUnread(target: NodeTarget, thread: ThreadRecord): void {
      services.visits?.markUnread(target, thread.id);
    },
    copyId(thread: ThreadRecord): void {
      copy(thread.id, "Thread ID copied");
    },
    /** `jhin://<nodeId>/threads/<id>` (D24), resolvable through any node of the mesh. */
    copyAddress(target: NodeTarget, thread: ThreadRecord): void {
      const nodeId = nodeIdOf(services.mesh, target);
      if (nodeId === undefined) {
        copy(thread.id, "Thread ID copied");
        return;
      }
      copy(`jhin://${nodeId}/threads/${thread.id}`, "Thread address copied");
    },
    copyPath(project: ProjectRecord): void {
      copy(project.path, "Path copied");
    },
    async renameProject(target: NodeTarget, project: ProjectRecord): Promise<void> {
      const name = await dialogs?.prompt({
        title: "Rename project",
        label: "Project name",
        value: project.name,
        confirmLabel: "Rename",
        validate: (value) => (value.trim() === "" ? "A project needs a name" : undefined),
      });
      if (name === undefined || name.trim() === project.name) return;
      try {
        await threads.call(target, "projects.update", { projectId: project.id, name: name.trim() });
      } catch (error) {
        fail("Failed to rename project", error);
      }
    },
    async removeProject(target: NodeTarget, project: ProjectRecord, threadCount: number) {
      if (
        dialogs !== undefined &&
        !(await dialogs.confirm({
          title: `Remove project "${project.name}"?`,
          description:
            threadCount === 0
              ? "Its folder stays on disk."
              : `Its ${threadCount} ${threadCount === 1 ? "thread is" : "threads are"} deleted. Its folder stays on disk.`,
          confirmLabel: "Remove",
          variant: "destructive",
        }))
      ) {
        return;
      }
      try {
        await threads.call(target, "projects.delete", { projectId: project.id });
        const route = navigation.current();
        if (
          route.node === target.node &&
          route.remote === target.remote &&
          route.project === project.id
        ) {
          navigation.navigate({ node: target.node });
        }
      } catch (error) {
        fail("Failed to remove project", error);
      }
    },
  };
}
