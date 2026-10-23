// `/feedback` in the composer (providers.md D1317). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/client-runtime/src/state/threadFeedback.ts
// (parseCodexFeedbackCommand, codexFeedbackNotice).

/** `/feedback [reason]` sent alone; null for anything else. */
export function parseFeedbackCommand(text: string): { readonly reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const reason = match[1]?.trim();
  return reason ? { reason } : {};
}

/** A `/feedback` sent from the composer, as it goes. */
export type FeedbackSubmission = { readonly id: string } & (
  | { readonly status: "uploading" }
  | { readonly status: "sent"; readonly feedbackId: string }
  | { readonly status: "failed"; readonly errorMessage: string }
);

/** T3's banner text of a submission. */
export function feedbackNotice(submission: FeedbackSubmission): {
  readonly title: string;
  readonly description?: string;
} {
  switch (submission.status) {
    case "uploading":
      return { title: "Sending feedback to OpenAI..." };
    case "sent":
      return {
        title: "Feedback sent to OpenAI",
        description: `Thread ID: ${submission.feedbackId}`,
      };
    case "failed":
      return { title: "Could not send feedback to OpenAI", description: submission.errorMessage };
  }
}
