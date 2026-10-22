// The writer turn itself is @jhin/agent-api's askAgent (t3-parity.md D1174).
// The prompts follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/provider-core/src/server/textGenerationPrompts.ts (buildCommitMessagePrompt,
// buildPrContentPrompt, buildBranchNamePrompt).
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { askAgent, parseJsonObject, type AgentRuntime, type Deadline } from "@jhin/agent-api";

export { parseJsonObject };

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
  /** The subjects alone, newest first. */
  readonly subjects: readonly string[];
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
  /**
   * A branch name for the work a thread's first message asks for, if a model
   * gave one: a fragment, a fragment with a prefix of its own (`semantic`) or
   * the complete name (`custom`), as `naming` asks (D1126).
   */
  branchName(input: BranchNameInput): Promise<string | undefined>;
}

/** T3's branch naming settings (D1126). */
interface BranchNaming {
  readonly mode: "static" | "semantic" | "custom";
  readonly prefix: string;
  readonly instructions: string;
}

interface BranchNameInput {
  readonly message: string;
  /** What was sent with the message: named in the prompt (D1127). */
  readonly attachments?: readonly {
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes?: number;
  }[];
  readonly naming?: BranchNaming;
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

/** T3's branch name prompt (`buildBranchNamePrompt`) for each naming mode (D1126, D1127). */
function branchNamePrompt(input: BranchNameInput): string {
  const mode = input.naming?.mode;
  const instructions = mode === "custom" ? input.naming?.instructions.trim() : undefined;
  const attachments = (input.attachments ?? []).map((attachment) =>
    // An inline image has no recorded size: none is claimed for it.
    attachment.sizeBytes === undefined
      ? `- ${attachment.name} (${attachment.mimeType})`
      : `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );
  return [
    "You generate concise git branch names.",
    "Return a JSON object with key: branch.",
    "Rules:",
    "- Branch should describe the requested work from the user message.",
    "- Return a valid Git branch name without spaces.",
    ...(mode === "custom"
      ? [
          "- Return the complete branch name, following the user's naming instructions. No prefix or suffix will be added.",
        ]
      : [
          "- Keep it short and specific (2-6 words), in lowercase with hyphen-separated words.",
          mode === "semantic"
            ? "- Include a semantic prefix and a slash in the branch name, for example feat/add-search, fix/login-error, refactor/auth, docs/setup, or chore/update-deps. Choose the prefix that best describes the work."
            : "- Return only the descriptive branch fragment, without a prefix or namespace. The application adds the configured prefix.",
        ]),
    "",
    "User message:",
    section(input.message, 8_000),
    ...(instructions ? ["", "Additional instructions:", section(instructions, 20_000)] : []),
    ...(attachments.length > 0
      ? ["", "Attachment metadata:", section(attachments.join("\n"), 4_000)]
      : []),
  ].join("\n");
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
    const subjects = input.subjects.filter((line) => line !== "");
    const title = subjects.length === 1 ? subjects[0]! : input.head;
    const summary = (subjects.length === 0 ? [title] : subjects).map((line) => `- ${line}`);
    return { title, body: ["## Summary", ...summary, "", "## Testing", "- Not run"].join("\n") };
  },
  // T3 keeps the temporary branch when no model names one.
  async branchName() {
    return undefined;
  },
};

/**
 * A writer asking `runtime()` (an agent of the node) and falling back to
 * `plainWriter` when there is none or its answer is not what was asked for.
 */
export function agentWriter(options: {
  runtime: () => Promise<AgentRuntime | undefined>;
  /** Starts the time a turn may take; a turn past it falls back to `plainWriter`. */
  deadline?: () => Deadline;
  warn: (message: string, fields: Record<string, unknown>) => void;
}): Writer {
  const answer = async (prompt: string): Promise<Record<string, unknown> | undefined> => {
    const runtime = await options.runtime();
    if (runtime === undefined) return undefined;
    try {
      // The prompt carries the repository's own text (its diff, its template): the turn runs
      // in an empty folder of its own, so nothing it is talked into can reach the repository.
      const cwd = await Fs.mkdtemp(Path.join(Os.tmpdir(), "jhin-writer-"));
      let answered: string;
      try {
        answered = await askAgent(
          runtime,
          { prompt, cwd, id: randomUUID(), label: "jhin.source-control.writer" },
          options.deadline?.(),
        );
      } finally {
        await Fs.rm(cwd, { recursive: true, force: true });
      }
      const parsed = parseJsonObject(answered);
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
    async branchName(input) {
      const branch = text((await answer(branchNamePrompt(input)))?.["branch"])?.trim();
      return branch === undefined || branch === "" ? undefined : branch;
    },
  };
}
