import {
  RELAY_PREFIX,
  parseRelayStream,
  relayStream,
  type FollowedMemberStream,
  type MeshStreams,
} from "@jhin/mesh-api";
import type { LiveStreams } from "@jhin/rpc";
import { z, type CommandDefinition } from "@jhin/sdk";

import type { Mesh } from "./mesh.ts";
import type { MemberView } from "./types.ts";

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

/** A member as `mesh.nodes` and `mesh.resolve` show it. */
export const NodeView = z.object({
  nodeId: z.string(),
  name: z.string(),
  urls: z.array(z.string()),
  self: z.boolean(),
  linked: z.boolean(),
  reachable: z.boolean(),
  route: z.array(z.string()).optional(),
});

export const describeMember = (member: MemberView): z.output<typeof NodeView> => ({
  nodeId: member.record.nodeId,
  name: member.record.name,
  urls: [...member.record.urls],
  self: member.self,
  linked: member.linked,
  reachable: member.reachable,
  ...(member.route === undefined ? {} : { route: [...member.route] }),
});

/** `mesh.nodes`, as `jhin.mesh` registers it. */
export function meshNodesCommand(mesh: Mesh) {
  return {
    name: "mesh.nodes",
    description: "Every node of the mesh, whether it is reachable, and the route to it",
    input: z.object({}),
    output: z.array(NodeView),
    permissions: ["mesh.read"],
    handler: () => mesh.members().map(describeMember),
  } satisfies CommandDefinition<z.ZodType, z.ZodType>;
}

/** `mesh.open` (D26), as `jhin.mesh` registers it. */
export function meshOpenCommand(mesh: Mesh) {
  return {
    name: "mesh.open",
    description:
      "Starts keeping a copy of another node's stream here (D26) and names the local stream to read",
    input: z.object({ node: z.string().min(1), stream: z.string().min(1) }),
    output: z.object({ stream: z.string() }),
    permissions: ["mesh.open"],
    handler: ({ node, stream }) => ({ stream: mesh.mirror(node, stream) }),
  } satisfies CommandDefinition<z.ZodType, z.ZodType>;
}

/** `mesh.close`, as `jhin.mesh` registers it. */
export function meshCloseCommand(mesh: Mesh) {
  return {
    name: "mesh.close",
    description: "Stops keeping a copy of another node's stream; what was copied stays readable",
    input: z.object({ node: z.string().min(1), stream: z.string().min(1) }),
    output: z.object({}),
    permissions: ["mesh.open"],
    handler: ({ node, stream }) => {
      mesh.unmirror(node, stream);
      return {};
    },
  } satisfies CommandDefinition<z.ZodType, z.ZodType>;
}

/**
 * `mesh.streams@1.1` as `jhin.mesh` provides it (D501, D1522): sharing, and
 * the relays of `mesh` used in process, so a plugin follows a member's stream
 * the way a relay passes it to a client. The owner of the stream applies its
 * member grants; nothing is stored here.
 */
export function meshStreams(mesh: Mesh): Required<MeshStreams> {
  return {
    share: (name) => mesh.share(name),
    follow(node, stream, after, listener, onEnd): FollowedMemberStream {
      if (mesh.relays.follow === undefined) {
        return { ready: Promise.reject(new Error("This mesh has no relays")), dispose: () => {} };
      }
      const followed = mesh.relays.follow(relayStream(node, stream), after, listener, (error) =>
        onEnd?.(error),
      );
      // Nobody may be waiting on `ready` (a follower disposed before it attached).
      followed.ready.catch(() => undefined);
      return followed;
    },
    members: () =>
      mesh
        .members()
        .filter((member) => !member.self)
        .map((member) => ({ nodeId: member.record.nodeId, reachable: member.reachable })),
    onChange: (listener) => mesh.onChange(listener),
  };
}
