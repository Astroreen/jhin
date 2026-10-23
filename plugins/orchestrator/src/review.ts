import type { Slice } from "@jhin/missions-api";

/**
 * What a review slice's assignee reads (docs/plans/agents.md D1244–D1246):
 * the project's rules, the plans that own what changed, the lore and the
 * diff, and only then the lead's notes. A reviewer checks against the project,
 * not against the list of whoever wrote the work ("own homework").
 */

/** The longest message `agents.send` takes (`MAX_MESSAGE_LENGTH`), less room for the handoff. */
export const REVIEW_BRIEF_LENGTH = 26_000;

/** Each part's share of the brief (D1245); the diff takes what the others leave. */
const BUDGET = { rules: 8_000, plans: 7_000, lore: 2_500, work: 2_500, notes: 2_000 } as const;

/** One source of the brief: its text, or why there is none. */
export interface Part {
  readonly address: string;
  readonly text?: string;
  readonly missing?: string;
}

export interface ReviewedWork {
  readonly slice: Slice;
  /** `git.diff` of where the slice's work lives. */
  readonly diff?: {
    readonly scope: string;
    readonly baseRef: string | null;
    readonly patch: string;
    readonly files: readonly { path: string; insertions: number; deletions: number }[];
  };
  readonly missing?: string;
}

/**
 * The plans that own the changed files, as the map routes to them (D1244): a
 * map row naming a changed package (`@jhin/<dir>` for `packages/<dir>`), plugin
 * (`jhin.<dir>` for `plugins/<dir>`) or client plugin (`<dir>` for
 * `apps/web/src/plugins/<dir>`) in backticks gives its plan addresses, and a
 * changed plan owns itself. Addresses are project-relative, map order kept.
 */
export function owningPlans(map: string, mapPath: string, changed: readonly string[]): string[] {
  const dir = mapPath.includes("/") ? mapPath.slice(0, mapPath.lastIndexOf("/") + 1) : "";
  const keys = new Set<string>();
  const plans = new Set<string>();
  for (const path of changed) {
    const [top, name, ...rest] = path.split("/");
    if (top === "packages" && name !== undefined) keys.add(`@jhin/${name}`);
    if (top === "plugins" && name !== undefined) keys.add(`jhin.${name}`);
    if (top === "apps" && rest[0] === "src" && rest[1] === "plugins" && rest[2] !== undefined)
      keys.add(rest[2].replace(/\.tsx?$/, ""));
    if (/^docs\/plans\/[^/]+\.md$/.test(path)) plans.add(path);
  }
  for (const line of map.split("\n")) {
    const named = [...line.matchAll(/`([^`]+)`/g)].some((match) => keys.has(match[1]!));
    if (!named) continue;
    for (const match of line.matchAll(/\bplans\/[\w.-]+\.md(?:#[\w-]+)?/g)) {
      plans.add(`${dir}${match[0]}`);
    }
  }
  return [...plans];
}

/** At most `length` characters; a cut part names where the rest is. */
export function cut(text: string, length: number, address: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= length) return trimmed;
  return `${trimmed.slice(0, Math.max(0, length - 120)).trimEnd()}\n\n[… cut here: read the rest at \`${address}\`]`;
}

const partText = (part: Part, length: number) =>
  part.text === undefined
    ? `(\`${part.address}\`: ${part.missing ?? "not available"})`
    : `<!-- ${part.address} -->\n${cut(part.text, length, part.address)}`;

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}diff\n${text.replace(/\n$/, "")}\n${marks}`;
}

/** The brief of a review slice (D1244, D1245). */
export function reviewBriefText(input: {
  readonly slice: Slice;
  readonly rules: Part;
  readonly plans: readonly Part[];
  readonly lore: Part;
  readonly work: readonly ReviewedWork[];
}): string {
  const { slice } = input;
  const reviewed = input.work.map(({ slice: work, diff, missing }) => {
    const proof = work.proof?.items
      .map((item) =>
        item.kind === "command"
          ? `- \`${item.command}\`: ${item.output.split("\n").slice(-3).join(" ").trim()}`
          : `- ${item.url}`,
      )
      .join("\n");
    const files = diff?.files
      .map((file) => `- ${file.path} (+${file.insertions} −${file.deletions})`)
      .join("\n");
    return {
      head: [
        `### ${work.title} (\`${work.id}\`, ${work.status})`,
        "",
        // Who to send changes to: one review slice may cover several assignees' work (L3, D1266).
        ...(work.assignee === undefined ? [] : [`Built by ${work.assignee}.`, ""]),
        cut(work.spec, BUDGET.work, `slices_get { sliceId: "${work.id}" }`),
        ...(proof === undefined || proof === "" ? [] : ["", "Its proof:", "", proof]),
        "",
        diff === undefined
          ? `The diff: ${missing ?? "not available"}.`
          : `The diff (${diff.scope}${diff.baseRef === null ? "" : ` against ${diff.baseRef}`}), ${diff.files.length} file(s):`,
        ...(files === undefined || files === "" ? [] : ["", files]),
      ].join("\n"),
      patch: diff?.patch ?? "",
    };
  });
  const plansLength = Math.floor(BUDGET.plans / Math.max(1, input.plans.length));
  const parts = [
    "[Review handed to you]",
    "",
    "You review against the project, not against the list of whoever did the work. Begin with the question the author did not ask: should this be done at all? Then check the change against the rules and the plans' decisions below, and against what the mission serves.",
    "",
    "- A rename or removal of a public id (capability, command, slot, contribution, event type) is the owner's decision, made with a deprecation (AGENTS.md rule 8): say so, and ask through the lead.",
    "- Name what you checked (the rules and decisions by number), so a reader sees what you did not check.",
    '- Record your verdict on each slice you review with slices_review { sliceId, verdict, notes }: "approved" or "changes-requested", and in notes what you checked and found. The mission\'s commit or merge waits for an approval after the last change.',
    "- Send the changes you ask for to the slice's builder, named under its heading.",
    "",
    "## The project's rules",
    "",
    partText(input.rules, BUDGET.rules),
    "",
    "## The plans that own what changed",
    "",
    input.plans.length === 0
      ? "(No plan of the map names the changed files: find the owner through the map.)"
      : input.plans.map((plan) => partText(plan, plansLength)).join("\n\n"),
    "",
    "## Lore",
    "",
    partText(input.lore, BUDGET.lore),
    "",
    "## The work under review",
    "",
    reviewed.map((work) => work.head).join("\n\n"),
    "",
    "## The lead's notes",
    "",
    "Added to the review above, never in its place:",
    "",
    cut(slice.spec, BUDGET.notes, `slices_get { sliceId: "${slice.id}" }`) || "(none)",
  ].join("\n");
  // The diffs take what is left, split between the slices.
  const left = REVIEW_BRIEF_LENGTH - parts.length - 200;
  const each = Math.floor(left / Math.max(1, reviewed.length));
  const patches = reviewed
    .map((work, index) =>
      each < 400 || work.patch === ""
        ? ""
        : fence(
            cut(
              work.patch,
              each - 20,
              `git_diff for slice ${input.work[index]!.slice.id}, or git diff in its checkout`,
            ),
          ),
    )
    .filter((patch) => patch !== "");
  return patches.length === 0
    ? `${parts}\n`
    : `${parts}\n\n## The diff\n\n${patches.join("\n\n")}\n`;
}
