// T3 Code's secretRequestFailureMessage (MIT, see THIRD_PARTY_NOTICES.md):
// packages/client-runtime/src/secretRequest.ts.
import {
  SECRET_REQUEST_GENERIC_FAILURE,
  SECRET_REQUEST_USER_FACING_CODES,
} from "@jhin/secrets-api";

/**
 * Only the node's own refusals pass their message through: anything else (a
 * dropped connection, a malformed reply) gets the generic line, so a typed
 * value can never surface in the page (security.md D1032).
 */
export function secretRequestFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof code === "string" &&
    SECRET_REQUEST_USER_FACING_CODES.includes(code) &&
    typeof message === "string" &&
    message.trim() !== ""
    ? message
    : SECRET_REQUEST_GENERIC_FAILURE;
}
