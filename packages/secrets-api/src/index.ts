// The secret request's schemas, statuses and messages follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): packages/contracts/src/secretRequest.ts, the request_secret
// tool in packages/contracts/src/orchestratorMcp.ts and
// packages/client-runtime/src/secretRequest.ts.
import { z } from "@jhin/sdk";

/** `secrets.store@1` (docs/plans/security.md, D1022). */
export const SECRETS_STORE_CAPABILITY = "secrets.store";

/** The config section of `jhin.secrets`. */
export const SECRETS_CONFIG_SECTION = "jhin.secrets";

/** What a config file holds where a secret was (D1025): `$secret:<32 hex>`. */
export const CONFIG_SECRET_PATTERN = /^\$secret:[0-9a-f]{32}$/;

/** Whether `value` is a config secret's reference rather than a value. */
export function isConfigSecretReference(value: unknown): value is string {
  return typeof value === "string" && CONFIG_SECRET_PATTERN.test(value);
}

/**
 * Where a config secret belongs: its section and its path inside it, with
 * list positions as `*` (D1025). A reference resolves only at that place.
 */
export interface ConfigSecretPlace {
  readonly section: string;
  readonly path: readonly (string | number)[];
}

/** The place's key: `section` and the path, list positions as `*`. */
export function configSecretPlace(place: ConfigSecretPlace): string {
  return JSON.stringify([
    place.section,
    ...place.path.map((key) => (typeof key === "number" ? "*" : key)),
  ]);
}

/** A one-use reference to a value the user saved (D1030), T3's `SecretRef`. */
export const SECRET_REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
export const SecretRef = z
  .string()
  .regex(SECRET_REF_PATTERN)
  .describe("A secretRef from secrets_request: it works once, and you never see the value.");

/** How long a saved value waits for its consumer (T3's `SECRET_REF_TTL_MS`). */
export const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;

export const SECRETS_ERROR_MESSAGES = {
  SECRET_STORE_UNAVAILABLE: "This node keeps no secret store.",
  SECRET_STORE_UNREADABLE:
    "The secret store could not be opened (its key is missing or the file is damaged).",
  SECRET_REQUEST_NO_TURN:
    "Asking for a secret requires a running turn in the thread the request is for.",
  SECRET_REQUEST_OTHER_THREAD: "An agent asks for a secret in its own thread only.",
  SECRET_REQUEST_NOT_FOUND: "This secret request no longer exists.",
  SECRET_REQUEST_ANSWERED: "This secret request was already answered.",
  SECRET_REF_INVALID: "That secretRef is not valid.",
  SECRET_REF_UNAVAILABLE:
    "That secretRef was already used or does not exist. Ask the user again with secrets_request.",
  SECRET_REF_EXPIRED: "That secretRef expired. Ask the user again with secrets_request.",
} as const;
export type SecretsErrorCode = keyof typeof SECRETS_ERROR_MESSAGES;

/** A failure of the store or of a request; its message never holds a value. */
export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SecretsErrorCode, details: Record<string, unknown> = {}) {
    super(SECRETS_ERROR_MESSAGES[code]);
    this.name = "SecretsError";
    this.code = code;
    this.details = details;
  }
}

/** Codes whose message the card shows (D1032); anything else gets a generic line. */
export const SECRET_REQUEST_USER_FACING_CODES: readonly string[] = [
  "SECRET_REQUEST_NOT_FOUND",
  "SECRET_REQUEST_ANSWERED",
  "SECRET_STORE_UNAVAILABLE",
  "SECRET_STORE_UNREADABLE",
];

/**
 * `secrets.store@1`: the node's secrets, apart from its config files. Every
 * method is synchronous once the plugin is active: the host resolves config
 * layers synchronously (D1025). Only the node's own code reaches a value
 * (D1022): no command returns one.
 */
export interface SecretStore {
  /** Whether the store could be opened; `false`: reads give nothing and writes throw. */
  readonly readable: boolean;
  /** The value of a config secret's reference at `place`, or `undefined`. */
  resolveConfig(reference: string, place: ConfigSecretPlace): string | undefined;
  /** Keeps `value` for `place` and returns the reference a config file holds instead. */
  putConfig(value: string, place: ConfigSecretPlace): string;
  /** Forgets a config secret; nothing happens for an unknown reference. */
  deleteConfig(reference: string): void;
  /** Keeps a value the user saved and returns its one-use `secretRef` (D1030). */
  putRef(value: string, owner: { readonly projectId: string; readonly threadId: string }): string;
  /** Whether `ref` is kept and unused. */
  hasRef(ref: string): boolean;
  /**
   * Hands out the value of `ref` once, for `projectId` (D1031); throws a
   * `SecretsError` (`SECRET_REF_INVALID`, `SECRET_REF_UNAVAILABLE`,
   * `SECRET_REF_EXPIRED`) otherwise.
   */
  consumeRef(input: { readonly ref: string; readonly projectId: string }): string;
}

// --- Commands ---------------------------------------------------------------

export const SecretsStatus = z.object({
  /** `unreadable`: the store is there but could not be opened (D1023). */
  state: z.enum(["ready", "unreadable"]),
  /** Where the key is: the OS keychain or the key file beside the store. */
  key: z.enum(["keychain", "file"]),
  /** Which keychain, when the key is in one. */
  keychain: z.enum(["macos", "libsecret"]).nullable(),
  configSecrets: z.number().int().nonnegative(),
  openRefs: z.number().int().nonnegative(),
});
export type SecretsStatus = z.output<typeof SecretsStatus>;

const ClientRequestId = z.string().trim().min(1).max(200);

/** T3's `OrchestratorMcpRequestSecretInput`, plus the thread it is for. */
export const SecretRequestInput = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("What you need, shown as the card's title, e.g. 'GitHub webhook secret'."),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("One or two sentences on what it is for and where the user gets or also enters it."),
  placeholder: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Hint inside the input, e.g. 'Paste your GitHub token'."),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000)
    .optional()
    .describe("How long to wait for the user. Default 10 minutes."),
  clientRequestId: ClientRequestId.optional().describe(
    "Reuse when retrying a call that lost its result, so the user sees one card and its answer is returned again. Use a new id to ask again after timed_out or cancelled.",
  ),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe("The thread to ask in; the calling agent's own thread when omitted."),
});
export type SecretRequestInput = z.output<typeof SecretRequestInput>;

export const SecretRequestResult = z.union([
  z.object({
    status: z.literal("saved").describe("secretRef holds the value."),
    secretRef: SecretRef.describe(
      "Pass it to a tool that accepts a secretRef; it works once, and you never see the value.",
    ),
  }),
  z.object({
    status: z
      .enum(["declined", "cancelled", "timed_out"])
      .describe(
        "declined: the user chose not to. cancelled: the request ended with the turn. timed_out: the user did not answer in time; the card is closed, so ask again with a new clientRequestId if still needed.",
      ),
  }),
]);
export type SecretRequestResult = z.output<typeof SecretRequestResult>;

/** T3's `SecretRequestAnswerInput`. */
export const SecretRequestAnswerInput = z.object({
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  answer: z.discriminatedUnion("type", [
    z.object({ type: z.literal("save"), secret: z.string().trim().min(1) }),
    z.object({ type: z.literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = z.output<typeof SecretRequestAnswerInput>;

export const SecretRequestAnswerResult = z.object({ status: z.enum(["saved", "declined"]) });

// --- Thread events (D1028) ----------------------------------------------------

export const SecretsThreadEvents = {
  /** `SecretRequestOpened`: a card asks the user for a secret. */
  requestOpened: "secrets.request.opened",
  /** `SecretRequestClosed`: answered, declined or ended; never the value. */
  requestClosed: "secrets.request.closed",
} as const;

export interface SecretRequestOpened {
  readonly requestId: string;
  readonly turnId: string;
  readonly label: string;
  readonly reason: string;
  readonly placeholder?: string;
}

export type SecretRequestStatus = "saved" | "declined" | "cancelled";

export interface SecretRequestClosed {
  readonly requestId: string;
  readonly status: SecretRequestStatus;
}

// --- The card's words (T3's client-runtime/secretRequest.ts) ------------------

export const SECRET_REQUEST_PRIVACY_NOTE = "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";
export const SECRET_REQUEST_GENERIC_FAILURE = "Could not answer the request. Try again.";

/** The row a closed card shows. */
export function secretRequestClosedLabel(status: SecretRequestStatus): string {
  switch (status) {
    case "saved":
      return "Saved securely and kept private";
    case "declined":
      return "Declined";
    case "cancelled":
      return "Request ended";
  }
}
