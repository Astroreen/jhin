/**
 * Merges streams read in full into one replay (D722): each stream keeps its
 * own order (its sequence), and across streams the event that happened first
 * goes first, earlier lists winning a tie. A stream whose clock stepped back
 * stays in sequence order, so no event of it is skipped.
 */
export function mergeByTime<T extends { readonly at: string }>(
  lists: readonly (readonly T[])[],
): T[] {
  const next = lists.map(() => 0);
  const merged: T[] = [];
  for (;;) {
    let pick = -1;
    for (let index = 0; index < lists.length; index += 1) {
      const candidate = lists[index]![next[index]!];
      if (candidate === undefined) continue;
      // Compared as times, not as strings: any ISO 8601 form orders right.
      if (pick < 0 || Date.parse(candidate.at) < Date.parse(lists[pick]![next[pick]!]!.at)) {
        pick = index;
      }
    }
    if (pick < 0) return merged;
    merged.push(lists[pick]![next[pick]!]!);
    next[pick]! += 1;
  }
}
