// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/sourceControlPresentation.ts
// (getSourceControlPresentation: the provider's name, else its client definition's label, and
// its terminology), the labels of packages/source-control-*/src/client/definition.ts and
// packages/client-runtime/src/pullRequestLinkInput.ts (parsePullRequestReference with each
// forge's checkout command and URL). docs/plans/source-control.md D1444, D1445.
import type { ChangeRequestTerminology, PullRequestProvider } from "@jhin/source-control-api";

type ForgeKind = PullRequestProvider["kind"];

/** Each forge's own label, T3's client definitions' `label`. */
const FORGE_LABELS: Record<ForgeKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
  bitbucket: "Bitbucket",
  forgejo: "Forgejo",
};

const PULL_REQUEST: ChangeRequestTerminology = { singular: "pull request", shortLabel: "PR" };
const MERGE_REQUEST: ChangeRequestTerminology = { singular: "merge request", shortLabel: "MR" };

/** The forge's word for a pull request: GitLab says merge request. */
export function forgeTerminology(kind: ForgeKind | undefined): ChangeRequestTerminology {
  return kind === "gitlab" ? MERGE_REQUEST : PULL_REQUEST;
}

/** T3's `providerName` and terminology of a repository's forge. */
export function forgePresentation(provider: PullRequestProvider | null | undefined): {
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
} {
  return {
    providerName:
      provider?.name || (provider ? FORGE_LABELS[provider.kind] : undefined) || "source control",
    terminology: forgeTerminology(provider?.kind),
  };
}

/** T3's Azure DevOps `checkoutCommandId`: `--id N`, `-i N`, `--id=N` or the first argument. */
function azureCheckoutId(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") return parts[index + 1] ?? null;
    if (part.startsWith("--id=")) return part.slice("--id=".length) || null;
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

/** Each forge's checkout command, its argument (T3's `checkoutCommandArgument`). */
const CHECKOUT_COMMANDS: readonly ((input: string) => string | null)[] = [
  (input) => /^gh\s+pr\s+checkout\s+(.+)$/i.exec(input)?.[1]?.trim() ?? null,
  (input) => /^glab\s+mr\s+checkout\s+(.+)$/i.exec(input)?.[1]?.trim() ?? null,
  (input) => /^tea\s+(?:pr|pulls)\s+checkout\s+(.+)$/i.exec(input)?.[1]?.trim() ?? null,
  (input) => {
    const args = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i.exec(input)?.[1];
    return args ? azureCheckoutId(args) : null;
  },
];

/** Each forge's pull request URL (T3's `isChangeRequestReference`; Bitbucket has none). */
const PULL_REQUEST_URLS: readonly RegExp[] = [
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i,
  /^https:\/\/[^/\s]*gitlab[^/\s]*\/.+\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i,
  /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+[^/\s]+\/pulls\/(\d+)(?:[/?#].*)?$/i,
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i,
];

/**
 * T3's parsePullRequestReference: a forge's checkout command is read for its argument, then a
 * pull request URL stays as it is, and `123` / `#123` gives its digits; else null.
 */
export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const reference =
    CHECKOUT_COMMANDS.map((argument) => argument(trimmed)).find((value) => value !== null) ??
    trimmed;
  if (reference === "") return null;
  if (PULL_REQUEST_URLS.some((pattern) => pattern.test(reference))) return reference;
  return /^#?(\d+)$/.exec(reference)?.[1] ?? null;
}

/**
 * Which forge a pull request URL belongs to, by its shape (T3's `findByChangeRequestUrl`):
 * a link of another host than the project's has no status to say.
 */
export function forgeKindOfUrl(url: string): ForgeKind | undefined {
  if (/\/-\/merge_requests\/\d+/.test(url)) return "gitlab";
  if (/\/_git\/[^/]+\/pullrequest\/\d+/.test(url)) return "azure-devops";
  if (/\/pull-requests\/\d+/.test(url)) return "bitbucket";
  if (/\/pulls\/\d+/.test(url)) return "forgejo";
  if (/\/pull\/\d+/.test(url)) return "github";
  return undefined;
}
