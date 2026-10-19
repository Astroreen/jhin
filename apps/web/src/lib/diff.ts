/** One line of a hunk, with its numbers in the old and the new file. */
interface DiffLine {
  readonly kind: "context" | "add" | "delete" | "note";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

interface DiffHunk {
  /** The `@@ -a,b +c,d @@ section` line. */
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly change: "added" | "deleted" | "renamed" | "modified";
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly insertions: number;
  readonly deletions: number;
}

/** `a/path` or `b/path` as a diff header names it; `/dev/null` for none. */
function stripPrefix(path: string): string | undefined {
  const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  if (unquoted === "/dev/null") return undefined;
  return unquoted.replace(/^[ab]\//, "");
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses `git diff` output (several files, renames, binary files, untracked additions). */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = patch.split("\n");
  // `split` leaves an empty last element for output ending in a newline.
  if (lines.at(-1) === "") lines.pop();
  let index = 0;
  while (index < lines.length) {
    const header = lines[index]!;
    if (!header.startsWith("diff --git ")) {
      index++;
      continue;
    }
    index++;
    const names = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(header);
    let path = names?.[2] ?? "";
    let previousPath: string | undefined = names?.[1];
    let change: DiffFile["change"] = "modified";
    let binary = false;
    while (
      index < lines.length &&
      !lines[index]!.startsWith("@@") &&
      !lines[index]!.startsWith("diff --git ")
    ) {
      const line = lines[index]!;
      if (line.startsWith("new file mode")) change = "added";
      else if (line.startsWith("deleted file mode")) change = "deleted";
      else if (line.startsWith("rename from ")) previousPath = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) {
        path = line.slice("rename to ".length);
        change = "renamed";
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
      else if (line.startsWith("--- ")) {
        const old = stripPrefix(line.slice(4));
        if (old === undefined) change = "added";
        else previousPath = old;
      } else if (line.startsWith("+++ ")) {
        const next = stripPrefix(line.slice(4));
        if (next === undefined) change = "deleted";
        else path = next;
      }
      index++;
    }
    const hunks: DiffHunk[] = [];
    let insertions = 0;
    let deletions = 0;
    while (index < lines.length && lines[index]!.startsWith("@@")) {
      const hunkHeader = lines[index]!;
      const match = HUNK.exec(hunkHeader);
      let oldLine = Number(match?.[1] ?? 0);
      let newLine = Number(match?.[2] ?? 0);
      index++;
      const hunkLines: DiffLine[] = [];
      while (index < lines.length) {
        const line = lines[index]!;
        if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
        const marker = line[0];
        const text = line.slice(1);
        if (marker === "+") {
          hunkLines.push({ kind: "add", text, newLine: newLine++ });
          insertions++;
        } else if (marker === "-") {
          hunkLines.push({ kind: "delete", text, oldLine: oldLine++ });
          deletions++;
        } else if (marker === "\\") {
          hunkLines.push({ kind: "note", text: line.slice(2) });
        } else {
          hunkLines.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
        }
        index++;
      }
      hunks.push({ header: hunkHeader, lines: hunkLines });
    }
    if (change === "added" || change === "deleted" || previousPath === path)
      previousPath = undefined;
    files.push({
      path: change === "deleted" ? (previousPath ?? path) : path,
      ...(previousPath === undefined || change !== "renamed" ? {} : { previousPath }),
      change,
      binary,
      hunks,
      insertions,
      deletions,
    });
  }
  return files;
}
