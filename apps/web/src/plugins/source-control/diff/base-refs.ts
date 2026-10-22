// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/baseRefChoices.ts.
import type { Branch } from "@jhin/source-control-api";

export interface BaseRefChoice {
  readonly id: string;
  readonly label: string;
  readonly local: Branch | null;
  readonly remote: Branch | null;
}

/** `origin/main` → `origin`; git's remote branch names lead with their remote. */
function remoteOf(ref: Branch): string {
  return ref.name.slice(0, Math.max(0, ref.name.indexOf("/")));
}

function remoteBranchName(ref: Branch): string {
  const remote = remoteOf(ref);
  return remote.length > 0 ? ref.name.slice(remote.length + 1) : ref.name;
}

/** Each local branch paired with its remote one (origin first), then the remote-only branches. */
export function buildBaseRefChoices(
  localRefs: ReadonlyArray<Branch>,
  remoteRefs: ReadonlyArray<Branch>,
): ReadonlyArray<BaseRefChoice> {
  const unusedRemoteRefs = new Set(remoteRefs);
  const pairedChoices = localRefs.map((local) => {
    const matches = remoteRefs.filter(
      (remote) => unusedRemoteRefs.has(remote) && remoteBranchName(remote) === local.name,
    );
    const remote = matches.find((candidate) => remoteOf(candidate) === "origin") ?? matches[0];
    if (remote) unusedRemoteRefs.delete(remote);
    return { id: `local:${local.name}`, label: local.name, local, remote: remote ?? null };
  });

  const remoteOnlyChoices = remoteRefs
    .filter((remote) => unusedRemoteRefs.has(remote))
    .map((remote) => ({
      id: `remote:${remote.name}`,
      label: remote.name,
      local: null,
      remote,
    }));

  return [...pairedChoices, ...remoteOnlyChoices];
}

export function filterBaseRefChoices(
  choices: ReadonlyArray<BaseRefChoice>,
  query: string,
): ReadonlyArray<BaseRefChoice> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return choices;
  return choices.filter(
    (choice) =>
      choice.label.toLocaleLowerCase().includes(normalizedQuery) ||
      choice.local?.name.toLocaleLowerCase().includes(normalizedQuery) === true ||
      choice.remote?.name.toLocaleLowerCase().includes(normalizedQuery) === true,
  );
}
