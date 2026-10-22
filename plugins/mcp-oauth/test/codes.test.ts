import * as Crypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { createOAuth, urlsFor, type PendingCode } from "../src/oauth.ts";

describe("authorization codes (security.md D1195)", () => {
  it("expire 60 seconds after approval, on a clock the test sets", () => {
    let now = 1_000_000;
    const oauth = createOAuth({
      key: "k".repeat(43),
      codes: new Map<string, PendingCode>(),
      defaultScopes: ["threads.read"],
      now: () => now,
    });
    const urls = urlsFor("http://127.0.0.1:7777");
    const redirect = "http://127.0.0.1:40000/callback";
    const registered = oauth.register({ client_name: "Agent", redirect_uris: [redirect] });
    if (registered.kind !== "ok") throw new Error("registration failed");
    const verifier = Crypto.randomBytes(48).toString("base64url");
    const challenge = Crypto.createHash("sha256").update(verifier).digest("base64url");
    const params = {
      client_id: registered.client.clientId,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const approveAt = (at: number) => {
      now = at;
      const validated = oauth.validate(urls, params);
      if (validated.kind !== "ok") throw new Error("invalid request");
      const back = new URL(oauth.approve(validated.request, { id: "owner", permissions: ["*"] }));
      return back.searchParams.get("code")!;
    };
    const exchange = (code: string) =>
      oauth.exchange(urls, {
        grant_type: "authorization_code",
        code,
        client_id: registered.client.clientId,
        redirect_uri: redirect,
        code_verifier: verifier,
      }).kind;

    const late = approveAt(1_000_000);
    now = 1_000_000 + 60_000;
    expect(exchange(late)).toBe("error");

    const inTime = approveAt(2_000_000);
    now = 2_000_000 + 59_999;
    expect(exchange(inTime)).toBe("ok");
  });
});
