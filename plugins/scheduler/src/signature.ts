// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/scheduledTasks/webhookVerification.ts at v0.1.1-nightly.20261020.3411:
// the HMAC-SHA256 check of a webhook's raw body and the constant-time comparison.
import * as Crypto from "node:crypto";

import type { WebhookSignature } from "@jhin/scheduler-api";

/** Constant-time string comparison that does not leak length through timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = Crypto.createHash("sha256").update(a).digest();
  const digestB = Crypto.createHash("sha256").update(b).digest();
  return Crypto.timingSafeEqual(digestA, digestB);
}

export function verifyWebhookSignature(input: {
  readonly signature: WebhookSignature;
  readonly secret: string;
  /** Lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}): boolean {
  const received = input.headers[input.signature.header.toLowerCase()];
  if (received === undefined) return false;
  const value = received.trim();
  const prefix = input.signature.prefix;
  if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const digest = Crypto.createHmac("sha256", input.secret).update(input.body).digest();
  const expected =
    input.signature.encoding === "hex" ? digest.toString("hex") : digest.toString("base64");
  const candidate = value.slice(prefix.length);
  return constantTimeEquals(
    input.signature.encoding === "hex" ? candidate.toLowerCase() : candidate,
    expected,
  );
}
