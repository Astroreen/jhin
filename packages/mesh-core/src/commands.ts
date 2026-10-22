import { RELAY_PREFIX, parseRelayStream } from "@jhin/mesh-api";
import type { LiveStreams } from "@jhin/rpc";
import { z, type CommandDefinition } from "@jhin/sdk";

import type { Mesh } from "./mesh.ts";

/**
 * `mesh.call`, as `jhin.mesh` registers it: the target runs the command with
 * no more than this caller holds here (security.md D416).
 */
export function meshCallCommand(mesh: Mesh) {
  return {
    name: "mesh.call",
    description: "Runs a command on another node of the mesh, through relays when needed",
    input: z.object({
      node: z.string().min(1),
      method: z.string().min(1),
      params: z.unknown().optional(),
    }),
    output: z.unknown(),
    permissions: ["mesh.call"],
    handler: ({ node, method, params }, invocation) =>
      mesh.call(node, method, params ?? {}, invocation.traceId, invocation.caller?.permissions),
  } satisfies CommandDefinition<z.ZodType, z.ZodType>;
}

/** `mesh.relay` (D502), registered only where relays are served (`rpc.streams@1.2`). */
export function meshRelayCommand(mesh: Mesh) {
  return {
    name: "mesh.relay",
    description:
      "Names the stream to subscribe to for another node's stream as it happens (D502): relay/<node>/<stream>, or the stream itself for this node",
    input: z.object({ node: z.string().min(1), stream: z.string().min(1) }),
    output: z.object({ stream: z.string() }),
    permissions: ["mesh.call"],
    handler: ({ node, stream }) => ({ stream: mesh.relay(node, stream) }),
  } satisfies CommandDefinition<z.ZodType, z.ZodType>;
}

/**
 * Serves this node's relays through its live streams (D499). A subscriber
 * needs `mesh.call` and what the relayed stream needs on this node: one
 * owner's nodes run the same plugins, so a relay never reads more than the
 * subscriber could read here (security.md D415). A stream nothing serves or
 * guards needs `events.read`.
 */
export function serveRelays(mesh: Mesh, live: Pick<LiveStreams, "serve" | "sourceOf" | "guardOf">) {
  return live.serve(RELAY_PREFIX, mesh.relays, {
    permissions: (name) => {
      const stream = parseRelayStream(name)?.stream;
      if (stream === undefined) return ["mesh.call"];
      const needs = live.sourceOf(stream)?.permissions ?? live.guardOf(stream) ?? ["events.read"];
      return ["mesh.call", ...needs];
    },
  });
}
