// Pairing and the page's own session (security.md D420–D422), as T3 Code's
// web client does it (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/auth/PairingRouteSurface.tsx and packages/shared/src/remote.ts.

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
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/rpc`;
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

/** Exchanges a pairing code for a device token at the node behind `webSocketUrl` (D420). */
export async function pairWithCode(
  webSocketUrl: string,
  code: string,
  label: string,
): Promise<{ token: string }> {
  const response = await fetch(`${httpBase(webSocketUrl)}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, label }),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { token: string };
}

/**
 * Whether this page's own node holds a session for it: `undefined` when the
 * page is not served by a node (a `jhin client` page). A failed request
 * throws: an unreachable node is not "no node", so a token never gets saved
 * in the page because of a network error.
 */
export async function currentSession(): Promise<boolean | undefined> {
  const response = await fetch("/auth/session", { credentials: "same-origin" });
  if (response.status === 404) return undefined;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  return response.ok;
}

/** Turns a pairing code or token into this page's session cookie (D421). */
export async function openSession(credential: string): Promise<void> {
  const response = await fetch("/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) throw await failure(response);
}

/** Signs this page out of its node: the token behind the cookie is revoked. */
export async function closeSession(): Promise<void> {
  await fetch("/auth/session", { method: "DELETE", credentials: "same-origin" });
}
