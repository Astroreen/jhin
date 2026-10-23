// Pairing and the page's own session (security.md D420–D422), as T3 Code's
// web client does it (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/auth/PairingRouteSurface.tsx and packages/shared/src/remote.ts.

import { dpopProof, type DeviceKey } from "./dpop.ts";

/**
 * The path this page's node serves the client under: `/`, or `/jhin/` behind a
 * proxy path. A pairing link's own `/pair` is not part of it.
 */
export function pageBase(pathname: string = globalThis.location?.pathname ?? "/"): string {
  return pathname.replace(/\/pair\/?$/, "/").replace(/[^/]*$/, "");
}

/** This page's own node's session endpoint, under the page's base path. */
const sessionEndpoint = () => `${pageBase()}auth/session`;

/** `ws(s)://host/rpc` → `http(s)://host`, where a node answers HTTP. */
export function httpBase(webSocketUrl: string): string {
  const url = new URL(webSocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/rpc\/?$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** `http(s)://host[/…]` → `ws(s)://host/rpc`, the node's RPC endpoint. */
export function rpcUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  // A node under a path behind a proxy (`https://h/jhin/`) keeps it; a pairing
  // link's own `/pair` is not part of it.
  const base = url.pathname.replace(/\/pair\/?$/, "").replace(/\/+$/, "");
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}${base}/rpc`;
}

/** A pairing link (`<node>/pair#token=<CODE>`, also `?token=`): the node and the code. */
export function parsePairingUrl(text: string): { url: string; code: string } | undefined {
  if (!URL.canParse(text.trim())) return undefined;
  const url = new URL(text.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const code = new URLSearchParams(url.hash.slice(1)).get("token") ?? url.searchParams.get("token");
  return code === null || code === "" ? undefined : { url: rpcUrl(url.toString()), code };
}

/** What a pairing code looks like once spaces and dashes are gone (T3's alphabet, D419). */
export const looksLikePairingCode = (text: string): boolean =>
  /^[23456789A-HJ-NP-Z]{12}$/.test(text.replace(/[\s-]/g, "").toUpperCase());

class PairingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function failure(response: Response): Promise<PairingError> {
  const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
  return new PairingError(
    body.code ?? `HTTP_${response.status}`,
    body.message ?? `The node answered ${response.status}`,
  );
}

/**
 * Exchanges a pairing code for a device token at the node behind
 * `webSocketUrl` (D420), bound to `key` when given (DPoP, security.md D1366):
 * `tokenType` says whether the node bound it.
 */
export async function pairWithCode(
  webSocketUrl: string,
  code: string,
  label: string,
  key?: DeviceKey,
): Promise<{ token: string; tokenType?: "DPoP" | "Bearer" }> {
  const endpoint = `${httpBase(webSocketUrl)}/auth/pair`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { dpop: await dpopProof(key, "POST", endpoint) }),
    },
    body: JSON.stringify({ code, label }),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { token: string; tokenType?: "DPoP" | "Bearer" };
}

/**
 * A one-time WebSocket ticket for a bound token (security.md D1367). A
 * refused token rejects with `UNAUTHENTICATED`, so the client stops retrying.
 */
export async function webSocketTicket(
  webSocketUrl: string,
  token: string,
  key: DeviceKey,
): Promise<string> {
  const endpoint = `${httpBase(webSocketUrl)}/auth/ws-ticket`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await dpopProof(key, "POST", endpoint, token),
      },
    });
  } catch (error) {
    throw Object.assign(new Error(`The node could not be reached: ${String(error)}`), {
      code: "CONNECT_FAILED",
    });
  }
  if (response.status === 401) {
    const refused = await failure(response);
    throw Object.assign(new Error(refused.message), { code: "UNAUTHENTICATED" });
  }
  if (!response.ok) {
    const failed = await failure(response);
    throw Object.assign(new Error(failed.message), { code: "CONNECT_FAILED" });
  }
  return ((await response.json()) as { ticket: string }).ticket;
}

/**
 * Whether this page's own node holds a session for it: `undefined` when the
 * page is not served by a node (a `jhin client` page). A failed request
 * throws: an unreachable node is not "no node", so a token never gets saved
 * in the page because of a network error.
 */
export async function currentSession(): Promise<boolean | undefined> {
  const response = await fetch(sessionEndpoint(), { credentials: "same-origin" });
  const json = (response.headers.get("content-type") ?? "").includes("application/json");
  if (json) return response.ok;
  // No node here: nothing at the path, or a `jhin client` page answering with its own HTML.
  if (response.status === 404 || response.ok) return undefined;
  // A proxy's 502 page or the like: the node may be there, just not answering now.
  throw new Error(`The node behind this page did not answer (${response.status})`);
}

/** Turns a pairing code or token into this page's session cookie (D421). */
export async function openSession(credential: string): Promise<void> {
  const response = await fetch(sessionEndpoint(), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) throw await failure(response);
}

/** Signs this page out of its node: the token behind the cookie is revoked. */
export async function closeSession(): Promise<void> {
  const response = await fetch(sessionEndpoint(), { method: "DELETE", credentials: "same-origin" });
  if (!response.ok) throw await failure(response);
}
