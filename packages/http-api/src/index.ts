import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { Disposable } from "@jhin/sdk";

export const HTTP_SERVER_CAPABILITY = "http.server";

export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** `http.server@1`: the node's single HTTP listener, shared by every plugin. */
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
}
