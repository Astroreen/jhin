export const AUTH_VERIFIER_CAPABILITY = "auth.verifier";

/** Who an authenticated connection acts as; becomes the commands' `caller`. */
export interface Principal {
  readonly id: string;
  readonly permissions: readonly string[];
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
