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
} as const;
