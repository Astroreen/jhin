// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/CommandPalette.logic.ts
// (search and ranking) and apps/web/src/lib/utils.ts (normalizeSearchText).

export interface SearchableItem {
  /** Fields matched by the query; the first is the title. */
  readonly searchTerms: readonly string[];
  /** Larger is more recent; breaks ties among threads. */
  readonly searchRecency?: number;
  /** Ranked after everything else that matches. */
  readonly secondary?: boolean;
}

export interface SearchGroup<T extends SearchableItem> {
  readonly value: string;
  readonly label: string;
  readonly items: readonly T[];
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function rankField(field: string, query: string, tokens: readonly string[]): number {
  const normalized = normalizeSearchText(field);
  if (normalized.length === 0 || !tokens.every((token) => normalized.includes(token))) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalized === query) return 3;
  if (normalized.startsWith(query)) return 2;
  if (normalized.includes(query)) return 1;
  return 0;
}

function rankItem(item: SearchableItem, query: string, tokens: readonly string[]): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  for (const [index, field] of terms.entries()) {
    const rank = rankField(field, query, tokens);
    if (rank === Number.NEGATIVE_INFINITY) continue;
    // A title match of a thread: recency decides among equal matches.
    if (index === 0 && item.searchRecency !== undefined) return 1_000 + Number(rank === 3);
    return 1_000 - index * 100 + rank;
  }
  return 0;
}

/**
 * The groups filtered by a query: every token must appear in an item's terms;
 * items rank by where and how well the query matches. A query starting with
 * `>` searches the actions only. Empty groups are dropped.
 */
export function filterSearchGroups<T extends SearchableItem>(
  groups: readonly SearchGroup<T>[],
  rawQuery: string,
  actionsGroup = "actions",
): SearchGroup<T>[] {
  const actionsOnly = rawQuery.startsWith(">");
  const query = normalizeSearchText(actionsOnly ? rawQuery.slice(1) : rawQuery);
  const candidates = actionsOnly ? groups.filter((group) => group.value === actionsGroup) : groups;
  if (query.length === 0) return [...candidates];
  const tokens = query.split(" ");
  return candidates.flatMap((group) => {
    const items = group.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) =>
        tokens.every((token) => normalizeSearchText(item.searchTerms.join(" ")).includes(token)),
      )
      .map((entry) => ({ ...entry, rank: rankItem(entry.item, query, tokens) }))
      .toSorted(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
          right.rank - left.rank ||
          (right.item.searchRecency ?? 0) - (left.item.searchRecency ?? 0) ||
          left.index - right.index,
      )
      .map((entry) => entry.item);
    return items.length === 0 ? [] : [{ value: group.value, label: group.label, items }];
  });
}
