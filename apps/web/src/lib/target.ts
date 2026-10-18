import type { NodeConnection } from "@jhin/client-api";

/** Where a thread lives: on the connected node, or on another node of its mesh. */
export interface ThreadTarget {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** The stream to read on the connected node: the thread itself, or its copy (D26). */
  open(threadId: string): Promise<string>;
}

export function threadTarget(node: NodeConnection, remote: string | undefined): ThreadTarget {
  if (remote === undefined) {
    return {
      call: (method, params) => node.client.call(method, params),
      open: async (threadId) => `thread/${threadId}`,
    };
  }
  return {
    call: (method, params) =>
      node.client.call("mesh.call", { node: remote, method, params: params ?? {} }),
    open: async (threadId) =>
      (
        await node.client.call<{ stream: string }>("mesh.open", {
          node: remote,
          stream: `thread/${threadId}`,
        })
      ).stream,
  };
}
