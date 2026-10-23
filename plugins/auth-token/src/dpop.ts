import * as Crypto from "node:crypto";

// DPoP proofs as T3 Code checks them (MIT, see THIRD_PARTY_NOTICES.md):
// packages/shared/src/dpop.ts — ES256 only, the method, the URL, a time
// window of 5 seconds ahead and 300 behind, and `ath` for a token's use.

const MAX_AGE_SECONDS = 300;
const MAX_SKEW_SECONDS = 5;
/** Proofs remembered at once (security.md D1366); past it new proofs are refused, never old ones forgotten. */
const MAX_REMEMBERED = 10_000;

type DpopFailure =
  | "missing_proof"
  | "malformed_proof"
  | "key_mismatch"
  | "method_mismatch"
  | "url_mismatch"
  | "access_token_hash_mismatch"
  | "time_window"
  | "invalid_signature"
  | "replay"
  | "busy";

export type DpopResult =
  | { readonly ok: true; readonly thumbprint: string }
  | { readonly ok: false; readonly failure: DpopFailure };

interface PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

const sha256 = (text: string) => Crypto.createHash("sha256").update(text).digest("base64url");

/** RFC 7638: the SHA-256 of the key's required members in lexical order. */
function jwkThumbprint(jwk: PublicJwk): string {
  return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

/** `ath`: the SHA-256 of the access token, base64url (RFC 9449 §4.2). */
const accessTokenHash = (token: string): string => sha256(token);

function json(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function publicJwk(value: unknown): PublicJwk | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || "d" in jwk) return undefined;
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return undefined;
  if (Buffer.from(jwk.x, "base64url").length !== 32) return undefined;
  if (Buffer.from(jwk.y, "base64url").length !== 32) return undefined;
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/**
 * Whether `htu` names the request: the host the client asked for, and a path
 * that ends with the request's (a proxy may strip a prefix). The scheme is
 * not compared: a TLS proxy the node does not trust tells it `http`.
 */
function sameTarget(htu: string, host: string | undefined, path: string): boolean {
  if (host === undefined || !URL.canParse(htu)) return false;
  const url = new URL(htu);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return false;
  }
  return url.host.toLowerCase() === host.toLowerCase() && url.pathname.endsWith(path);
}

/** The `jti`s seen per key, until their proofs could no longer be fresh. */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();

  /** False when `key` was seen within its window, or too many are remembered. */
  admit(key: string, nowSeconds: number): "ok" | "replay" | "busy" {
    for (const [seen, until] of this.#seen) if (until < nowSeconds) this.#seen.delete(seen);
    if (this.#seen.has(key)) return "replay";
    if (this.#seen.size >= MAX_REMEMBERED) return "busy";
    this.#seen.set(key, nowSeconds + MAX_AGE_SECONDS + MAX_SKEW_SECONDS);
    return "ok";
  }
}

export function verifyDpopProof(input: {
  readonly proof: string | undefined;
  readonly method: string;
  /** `requestedHost` of the request. */
  readonly host: string | undefined;
  /** The request's path, without its query. */
  readonly path: string;
  readonly nowSeconds: number;
  readonly replay: ReplayGuard;
  readonly expectedThumbprint?: string;
  readonly accessToken?: string;
}): DpopResult {
  const fail = (failure: DpopFailure): DpopResult => ({ ok: false, failure });
  if (input.proof === undefined || input.proof.trim() === "") return fail("missing_proof");
  const parts = input.proof.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return fail("malformed_proof");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = json(encodedHeader);
  const payload = json(encodedPayload);
  if (header === undefined || payload === undefined) return fail("malformed_proof");
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256") return fail("malformed_proof");
  const jwk = publicJwk(header.jwk);
  if (jwk === undefined) return fail("malformed_proof");
  const { htm, htu, jti, iat, ath } = payload;
  if (
    typeof htm !== "string" ||
    typeof htu !== "string" ||
    typeof jti !== "string" ||
    jti === "" ||
    jti.length > 256 ||
    typeof iat !== "number" ||
    !Number.isInteger(iat)
  ) {
    return fail("malformed_proof");
  }
  const thumbprint = jwkThumbprint(jwk);
  if (input.expectedThumbprint !== undefined && thumbprint !== input.expectedThumbprint) {
    return fail("key_mismatch");
  }
  if (htm.toUpperCase() !== input.method.toUpperCase()) return fail("method_mismatch");
  if (!sameTarget(htu, input.host, input.path)) return fail("url_mismatch");
  if (input.accessToken !== undefined && ath !== accessTokenHash(input.accessToken)) {
    return fail("access_token_hash_mismatch");
  }
  let verified = false;
  try {
    verified = Crypto.verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      {
        key: Crypto.createPublicKey({ key: { ...jwk }, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) return fail("invalid_signature");
  if (iat > input.nowSeconds + MAX_SKEW_SECONDS || input.nowSeconds - iat > MAX_AGE_SECONDS) {
    return fail("time_window");
  }
  const admitted = input.replay.admit(`${thumbprint}:${jti}`, input.nowSeconds);
  if (admitted !== "ok") return fail(admitted);
  return { ok: true, thumbprint };
}
