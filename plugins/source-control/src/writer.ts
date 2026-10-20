// The prompts follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/provider-core/src/server/textGenerationPrompts.ts (buildCommitMessagePrompt,
// buildPrContentPrompt).
import { randomUUID } from "node:crypto";

import type { AgentRuntime } from "@jhin/agent-api";

interface CommitMessageInput {
  readonly branch: string | null;
  /** `git diff --stat` of what is committed. */
  readonly summary: string;
  readonly patch: string;
  /** Also suggest a branch fragment for a feature branch. */
  readonly includeBranch: boolean;
}

interface PullRequestInput {
  readonly base: string;
  readonly head: string;
  /** `git log` subjects and bodies of the branch's commits. */
  readonly commits: string;
  readonly stat: string;
  readonly patch: string;
  /** The repository's template for a pull request's body. */
  readonly template?: string;
}

/** Writes commit messages and pull requests' titles and bodies (T3's text generation). */
export interface Writer {
  commitMessage(input: CommitMessageInput): Promise<{
    subject: string;
    body: string;
    branch?: string;
  }>;
  pullRequest(input: PullRequestInput): Promise<{ title: string; body: string }>;
}

const section = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;

function commitMessagePrompt(input: CommitMessageInput): string {
  return [
    "You write concise git commit messages.",
    input.includeBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    ...(input.includeBranch
      ? ["- branch must be a short semantic git branch fragment for this change"]
      : []),
    "- capture the primary user-visible or developer-visible change",
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    "Staged files:",
    section(input.summary, 6_000),
    "",
    "Staged patch:",
    section(input.patch, 40_000),
  ].join("\n");
}

function pullRequestPrompt(input: PullRequestInput): string {
  const template = input.template?.trim();
  return [
    "You write source control change request content.",
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title should be concise and specific",
    ...(template
      ? [
          "- body must be markdown and follow the repository change request template structure",
          "- fill in the template sections appropriately for this change",
          "- drop HTML comments from the template in the generated body",
          "- keep the template's markdown structure",
        ]
      : [
          "- body must be markdown and include headings '## Summary' and '## Testing'",
          "- under Summary, provide short bullet points",
          "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
        ]),
    ...(template ? ["", "Repository change request template:", section(template, 8_000)] : []),
    "",
    `Base branch: ${input.base}`,
    `Head branch: ${input.head}`,
    "",
    "Commits:",
    section(input.commits, 12_000),
    "",
    "Diff stat:",
    section(input.stat, 12_000),
    "",
    "Diff patch:",
    section(input.patch, 40_000),
  ].join("\n");
}

/** The first JSON object in an answer, fenced or not. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [
    fenced,
    text,
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ]) {
    if (candidate === undefined || candidate.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** The files a `git diff --stat` names, without its totals line. */
const statFiles = (stat: string) =>
  stat
    .split("\n")
    .map((line) => /^\s*(.+?)\s+\|\s/.exec(line)?.[1]?.trim())
    .filter((path): path is string => path !== undefined);

/**
 * Messages written without a model: what a node without an agent runtime (or
 * one that failed to answer) commits with.
 */
export const plainWriter: Writer = {
  async commitMessage(input) {
    const files = statFiles(input.summary);
    const subject =
      files.length === 1
        ? `Update ${files[0]!.split("/").at(-1)}`
        : `Update ${files.length === 0 ? "project" : files.length} files`;
    return {
      subject: files.length === 0 ? "Update project files" : subject,
      body: "",
      ...(input.includeBranch ? { branch: subject } : {}),
    };
  },
  async pullRequest(input) {
    const subjects = input.commits
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const title = subjects.length === 1 ? subjects[0]! : input.head;
    const summary = (subjects.length === 0 ? [title] : subjects).map((line) => `- ${line}`);
    return { title, body: ["## Summary", ...summary, "", "## Testing", "- Not run"].join("\n") };
  },
};

/**
 * Asks an agent runtime for the JSON the prompts describe, in a turn of its
 * own that reads nothing of any thread; every tool call it asks for is declined.
 */
async function ask(runtime: AgentRuntime, cwd: string, prompt: string): Promise<string> {
  const turn = runtime.startTurn({
    threadId: `jhin.source-control.writer-${randomUUID()}`,
    turnId: randomUUID(),
    input: { text: prompt },
    history: [],
    cwd,
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  let text = "";
  for await (const item of turn.items) {
    if (item.kind === "message.completed") text = item.text;
    if (item.kind !== "request.opened") continue;
    turn.respond?.(
      item.requestId,
      item.request.kind === "approval"
        ? { kind: "approval", decision: "decline" }
        : { kind: "user-input", answers: {} },
    );
  }
  return text;
}

/**
 * A writer asking `runtime()` (an agent of the node) and falling back to
 * `plainWriter` when there is none or its answer is not what was asked for.
 */
export function agentWriter(options: {
  runtime: () => Promise<AgentRuntime | undefined>;
  cwd: string;
  warn: (message: string, fields: Record<string, unknown>) => void;
}): Writer {
  const answer = async (prompt: string): Promise<Record<string, unknown> | undefined> => {
    const runtime = await options.runtime();
    if (runtime === undefined) return undefined;
    try {
      const parsed = parseJsonObject(await ask(runtime, options.cwd, prompt));
      if (parsed === undefined) {
        options.warn("the writer answered no JSON", { agentId: runtime.agentId });
      }
      return parsed;
    } catch (error) {
      options.warn("the writer failed", { agentId: runtime.agentId, error: String(error) });
      return undefined;
    }
  };
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    async commitMessage(input) {
      const parsed = await answer(commitMessagePrompt(input));
      const subject = text(parsed?.["subject"]);
      if (subject === undefined || subject.trim() === "") return plainWriter.commitMessage(input);
      const branch = text(parsed?.["branch"]);
      return {
        subject,
        body: text(parsed?.["body"]) ?? "",
        ...(input.includeBranch && branch ? { branch } : {}),
      };
    },
    async pullRequest(input) {
      const parsed = await answer(pullRequestPrompt(input));
      const title = text(parsed?.["title"]);
      if (title === undefined || title.trim() === "") return plainWriter.pullRequest(input);
      return { title, body: text(parsed?.["body"]) ?? "" };
    },
  };
}
