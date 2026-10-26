// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: the schemas of
// packages/contracts/src/composerContext.ts (OrchestrationMessageContext and its records).
//
// A message's context records as commands take them (t3-parity.md D1006): `threads.send`, the
// queue and the composer's `chat.composer.insert-context` (D1009). In a message each record is
// checked on its own, and one that fails is dropped, not the message, as in T3.
import { z } from "@jhin/sdk";

import {
  KNOWN_CONTEXT_KINDS,
  MESSAGE_CONTEXT_LABEL_MAX_CHARS,
  MESSAGE_CONTEXT_MAX_RECORDS,
  MESSAGE_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type MessageContext,
  type MessageContextRecord,
} from "./context.ts";
import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
} from "./citations.ts";

const ContextId = z
  .string()
  .max(128)
  .regex(/^[a-z0-9_-]+$/i);
const ShortString = z.string().max(2_048);
const Label = z.string().max(MESSAGE_CONTEXT_LABEL_MAX_CHARS);
const Base = { version: z.literal(1), contextId: ContextId, label: Label };

const PullRequestContextMetadata = z.object({
  number: z.number().int().positive(),
  title: ShortString,
  url: ShortString,
  headBranch: ShortString,
  baseBranch: ShortString,
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
});

const ReviewCommentRecord = z
  .object({
    ...Base,
    kind: z.literal("review-comment"),
    sectionId: z.string().trim().min(1).max(255),
    sectionTitle: ShortString,
    filePath: z.string().trim().min(1).max(2_048),
    startIndex: z.number().int().nonnegative(),
    endIndex: z.number().int().nonnegative(),
    rangeLabel: ShortString,
    text: z.string().max(16_000),
    diff: z.string().max(32_000),
    fenceLanguage: z.string().max(64).optional(),
    pullRequest: PullRequestContextMetadata.optional(),
  })
  .refine((record) => record.endIndex >= record.startIndex);

const ThreadRecord = z.object({
  ...Base,
  kind: z.literal("thread"),
  nodeId: z.string().trim().min(1).max(255),
  threadId: z.string().trim().min(1).max(255),
  title: Label,
});

const TerminalRecord = z
  .object({
    ...Base,
    kind: z.literal("terminal"),
    terminalId: z.string().trim().min(1).max(255),
    terminalLabel: z.string().trim().min(1).max(255),
    lineStart: z.number().int().nonnegative(),
    lineEnd: z.number().int().nonnegative(),
    text: z.string().max(MESSAGE_CONTEXT_TERMINAL_TEXT_MAX_CHARS),
  })
  .refine((record) => record.lineEnd >= record.lineStart);

const PreviewAnnotationRecord = z.object({
  ...Base,
  kind: z.literal("preview-annotation"),
  pageUrl: z.string().max(4096),
  pageTitle: z.string().max(1000),
  comment: z.string().max(20_000),
  elements: z
    .array(
      z.object({
        selector: z.string().max(2000),
        tagName: z.string().max(100),
        text: z.string().max(2000),
      }),
    )
    .min(1)
    .max(20),
});

/** A kind this node does not know: kept with its JSON payload, up to 64 000 characters. */
const UnknownRecord = z.object({
  ...Base,
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .refine((kind) => !(KNOWN_CONTEXT_KINDS as readonly string[]).includes(kind)),
  payload: z.unknown().refine((payload) => {
    try {
      const encoded = JSON.stringify(payload);
      return encoded !== undefined && encoded.length <= 64_000;
    } catch {
      return false;
    }
  }),
});

/** One record: T3's known kinds by their shapes, any other kind with a JSON payload. */
export const MessageContextRecordSchema: z.ZodType<MessageContextRecord> = z
  .union([
    ReviewCommentRecord,
    ThreadRecord,
    TerminalRecord,
    PreviewAnnotationRecord,
    UnknownRecord,
  ])
  .describe(
    "A context record (t3-parity.md D1006): review-comment, thread, terminal, preview-annotation or other",
  );

/** The records' JSON, at most 16 MB together (T3's bound). */
const MAX_SERIALIZED_CHARS = 16_000_000;

/** `{ version: 1, records }`; records that fail their check are dropped, ids stay unique. */
export const MessageContextSchema = z
  .object({
    version: z.literal(1),
    records: z
      .array(z.unknown())
      .describe(
        "Context records (t3-parity.md D1006): review-comment, thread, terminal or another kind",
      )
      .max(MESSAGE_CONTEXT_MAX_RECORDS)
      .refine((records) => {
        try {
          return JSON.stringify(records).length <= MAX_SERIALIZED_CHARS;
        } catch {
          return false;
        }
      }, "are too large together")
      .readonly(),
  })
  .transform((context): MessageContext => {
    const seen = new Set<string>();
    const records: MessageContextRecord[] = [];
    for (const candidate of context.records) {
      const parsed = MessageContextRecordSchema.safeParse(candidate);
      if (!parsed.success || seen.has(parsed.data.contextId)) continue;
      seen.add(parsed.data.contextId);
      records.push(parsed.data as MessageContextRecord);
    }
    return { version: 1, records };
  });

/** A quote of an agent's message (t3-parity.md D1010), as `chat.composer.insert-citation` takes it. */
export const AssistantCitationSchema: z.ZodType<AssistantCitation> = z
  .object({
    version: z.literal(1),
    nodeId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512),
    text: z
      .string()
      .max(ASSISTANT_CITATION_MAX_TEXT_LENGTH)
      .refine((text) => text.trim() !== ""),
    comment: z.string().max(ASSISTANT_CITATION_MAX_COMMENT_LENGTH).optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    prefix: z.string().max(ASSISTANT_CITATION_CONTEXT_LENGTH),
    suffix: z.string().max(ASSISTANT_CITATION_CONTEXT_LENGTH),
  })
  .refine((citation) => citation.end > citation.start);
