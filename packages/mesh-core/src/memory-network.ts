import { createPeerPair, type Peer } from "@jhin/rpc";

import type { JoinRequest, JoinResponse, MeshTransport } from "./types.ts";

interface Endpoint {
  accept(peer: Peer, token: string): boolean;
  join(request: JoinRequest): JoinResponse;
}

interface Pipe {
  readonly from: string;
  readonly to: string;
  readonly peer: Peer;
}

/**
 * Nodes in one process, wired by in-memory channels (D38). Each node has an
 * address; tests take addresses down, bring them back and cut routes between
 * two of them, which is how NAT and outages look to the mesh.
 */
export function createMemoryNetwork() {
  const endpoints = new Map<string, Endpoint>();
  const down = new Set<string>();
  const blocked = new Set<string>();
  const pipes = new Set<Pipe>();
  const key = (a: string, b: string) => [a, b].toSorted().join(" | ");

  const refuse = (message: string, code: string) =>
    Promise.reject(Object.assign(new Error(message), { code }));

  return {
    /** Serves the mesh endpoint of a node at `address`. */
    listen(address: string, endpoint: Endpoint): void {
      endpoints.set(address, endpoint);
    },
    /** The transport a node at `from` dials with. */
    transport(from: string): MeshTransport {
      return {
        dial(url, token) {
          const endpoint = endpoints.get(url);
          if (
            endpoint === undefined ||
            down.has(url) ||
            down.has(from) ||
            blocked.has(key(from, url))
          ) {
            return refuse(`${from} cannot reach ${url}`, "CONNECT_FAILED");
          }
          const [mine, theirs] = createPeerPair();
          if (!endpoint.accept(theirs, token)) {
            mine.close(4401, "unauthenticated");
            return refuse("Token refused", "UNAUTHENTICATED");
          }
          const pipe: Pipe = { from, to: url, peer: mine };
          pipes.add(pipe);
          mine.onClose(() => pipes.delete(pipe));
          return Promise.resolve(mine);
        },
        async join(url, request) {
          const endpoint = endpoints.get(url);
          if (endpoint === undefined || down.has(url) || blocked.has(key(from, url))) {
            throw Object.assign(new Error(`${from} cannot reach ${url}`), {
              code: "CONNECT_FAILED",
            });
          }
          return endpoint.join(request);
        },
      };
    },
    /** Stops serving `address`: links dialled to it close; its node can still dial out. */
    unlisten(address: string): void {
      endpoints.delete(address);
      for (const pipe of pipes) if (pipe.to === address) pipe.peer.close(1006, "moved");
    },
    /** Takes an address off the network, closing its links. */
    down(address: string): void {
      down.add(address);
      for (const pipe of pipes)
        if (pipe.from === address || pipe.to === address) pipe.peer.close(1006, "down");
    },
    up(address: string): void {
      down.delete(address);
    },
    /** Two addresses can no longer reach each other directly. */
    block(a: string, b: string): void {
      blocked.add(key(a, b));
      for (const pipe of pipes)
        if (key(pipe.from, pipe.to) === key(a, b)) pipe.peer.close(1006, "blocked");
    },
  };
}
