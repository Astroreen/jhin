import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { Disposable } from "@jhin/sdk";

export const HTTP_SERVER_CAPABILITY = "http.server";

export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** `http.server@1` (1.1): the node's single HTTP listener, shared by every plugin. */
export interface HttpServer {
  /** Base URL, e.g. `http://127.0.0.1:7777`. */
  readonly url: string;
  /**
   * Handles `method` requests to `path`. A path ending in `/*` matches every
   * path under it; otherwise the match is exact. The longest match wins.
   */
  route(method: string, path: string, handler: HttpHandler): Disposable;
  /** Handles WebSocket (or other) upgrades on an exact path. */
  upgrade(path: string, handler: UpgradeHandler): Disposable;
  /**
   * Since 1.1: the address `request` comes from, for rate limits and logs.
   * The socket's peer, unless that peer is one of `jhin.http.trustProxy`;
   * only then is the forwarded header (`jhin.http.forwardedHeader`) read.
   * Forwarded headers are never trusted by default.
   */
  clientAddress(request: IncomingMessage): string;
  /**
   * Since 1.2: the host (`name:port`) the client asked for: `X-Forwarded-Host`
   * when the socket's peer is one of `jhin.http.trustProxy`, else `Host`.
   * Undefined without either. Origin checks compare a browser's `Origin`
   * with it (security.md D418).
   */
  requestedHost(request: IncomingMessage): string | undefined;
}
