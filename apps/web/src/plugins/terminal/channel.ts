import type { RpcClient } from "@jhin/rpc";

import { nodeChannel, type NodeChannel } from "../../lib/node-channel.ts";

/**
 * What the terminal code talks to (D504): a connected node's client, or a
 * mesh member through it, with the same calls, subscriptions and the
 * connection's state (`lib/node-channel.ts`, shared since agents.md D1527).
 */
export type TerminalChannel = NodeChannel;

/** `client` itself, or the one channel to `member` through it: the same object every time. */
export const terminalChannel = (client: RpcClient, member: string | undefined): TerminalChannel =>
  nodeChannel(client, member, "This node cannot stream terminals of other nodes of its mesh");
