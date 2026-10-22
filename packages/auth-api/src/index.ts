export const AUTH_VERIFIER_CAPABILITY = "auth.verifier";

/** Who an authenticated connection acts as; becomes the commands' `caller`. */
export interface Principal {
  readonly id: string;
  /** Grants: permissions, patterns such as `git.*`, or `*` (security.md D410). */
  readonly permissions: readonly string[];
  /** Since 1.1: when the credential stops working (ms); transports drop the connection then. */
  readonly expiresAt?: number;
}

export interface Credentials {
  /** A bearer token, from a header or the WebSocket token subprotocol. */
  readonly token?: string;
}

/** `auth.verifier@1`: decides who a remote client is. */
export interface AuthVerifier {
  /** The principal for these credentials, or undefined to refuse the client. */
  verify(credentials: Credentials): Promise<Principal | undefined>;
}

/** The principal of the node's owner token (D30). */
export const OWNER_PRINCIPAL_ID = "owner";

/** The principal of a device token: `client:<id>` (security.md D411). */
export const clientPrincipalId = (id: string): string => `client:${id}`;

/** Kernel events transports act on (security.md D414). */
export const AuthEvents = {
  /** `{}`: the owner token changed; connections made with the old one are dropped. */
  tokenRotated: "auth.token.rotated",
  /** `{ principal }`: a device token was revoked; its connections are dropped. */
  clientRevoked: "auth.client.revoked",
  /**
   * `{}`: device tokens or open pairing codes changed (security.md D1188);
   * the transport turns it into the live stream `auth/clients`. Never carries a secret.
   */
  clientsChanged: "auth.clients.changed",
} as const;

/** The live stream that says the authorized clients changed (security.md D1188); needs `auth.read`. */
export const AUTH_CLIENTS_STREAM = "auth/clients";

/**
 * The httpOnly cookie that holds the device token of the node's own web page
 * (security.md D421), one per port as T3 Code names its session cookies.
 */
export const sessionCookieName = (port: string | number): string => `jhin_session_${port}`;

/** The value of cookie `name` in a `Cookie` header, if it is there. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const raw = part.slice(index + 1).trim();
      // The header is the client's: a malformed escape is no value, never a throw.
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The WHATWG URL parser both sides have (Node and browsers); the package has no DOM or Node types. */
declare const URL: new (input: string) => PlainUrlParts;
interface PlainUrlParts {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
}

/**
 * A node's address for a pairing link (security.md D1190): http(s), perhaps
 * under a path, never with credentials, a query or a fragment. The node and
 * the web client check it alike.
 */
export function isPlainHttpUrl(value: string): boolean {
  let url: PlainUrlParts;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    /^https?:$/.test(url.protocol) &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}
export {
  DEVICE_TYPES,
  deriveClientMetadata,
  type ClientMetadata,
  type DeviceType,
} from "./metadata.ts";
