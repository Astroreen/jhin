// DPoP proofs from the browser (security.md D1366, D1368), as T3 Code's web
// client makes them (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/cloud/dpop.ts —
// a P-256 key that never leaves WebCrypto, a proof per request.

/** A device's key: usable by this origin's scripts, never readable as bytes. */
export interface DeviceKey {
  readonly privateKey: CryptoKey;
  readonly jwk: {
    readonly kty: string;
    readonly crv: string;
    readonly x: string;
    readonly y: string;
  };
}

const subtle = () => globalThis.crypto?.subtle as SubtleCrypto | undefined;

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** A new key, or undefined where WebCrypto is missing (a page outside a secure context). */
export async function createDeviceKey(): Promise<DeviceKey | undefined> {
  const crypto = subtle();
  if (crypto === undefined) return undefined;
  try {
    const pair = await crypto.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const { kty, crv, x, y } = await crypto.exportKey("jwk", pair.publicKey);
    if (kty === undefined || crv === undefined || x === undefined || y === undefined) {
      return undefined;
    }
    return { privateKey: pair.privateKey, jwk: { kty, crv, x, y } };
  } catch {
    // A browser without P-256 pairs with a bearer token instead.
    return undefined;
  }
}

/** Whether `value` is a key saved by `createDeviceKey`. */
export function isDeviceKey(value: unknown): value is DeviceKey {
  const key = value as Partial<DeviceKey> | null;
  return (
    typeof CryptoKey !== "undefined" &&
    key?.privateKey instanceof CryptoKey &&
    typeof key.jwk?.x === "string" &&
    typeof key.jwk.y === "string"
  );
}

/** A proof for one request: `htm` and `htu`, and `ath` when it carries `token`. */
export async function dpopProof(
  key: DeviceKey,
  method: string,
  url: string,
  token?: string,
): Promise<string> {
  const crypto = subtle()!;
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  const ath =
    token === undefined
      ? undefined
      : base64url(await crypto.digest("SHA-256", new TextEncoder().encode(token)));
  const header = encodeJson({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk });
  const payload = encodeJson({
    htm: method,
    htu: target.toString(),
    jti: globalThis.crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...(ath === undefined ? {} : { ath }),
  });
  // WebCrypto signs ECDSA as r‖s, the JWS form ES256 needs.
  const signature = await crypto.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}
