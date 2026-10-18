import { describe, expect, it } from "vite-plus/test";

import {
  filterSearchGroups,
  normalizeSearchText,
  type SearchableItem,
} from "../src/lib/palette-search.ts";

interface Item extends SearchableItem {
  readonly id: string;
}

const item = (id: string, terms: string[], extra: Partial<Item> = {}): Item => ({
  id,
  searchTerms: terms,
  ...extra,
});

const ids = (groups: ReturnType<typeof filterSearchGroups<Item>>) =>
  groups.map((group) => [group.value, group.items.map((entry) => entry.id)]);

describe("normalizeSearchText", () => {
  it("folds case, accents and whitespace", () => {
    expect(normalizeSearchText("  Crème\tBrûlée  ")).toBe("creme brulee");
  });
});

describe("filterSearchGroups", () => {
  const groups = [
    {
      value: "actions",
      label: "Actions",
      items: [
        item("new", ["New thread", "Start a conversation"]),
        item("settings", ["Open settings", "preferences"]),
      ],
    },
    {
      value: "threads",
      label: "Threads",
      items: [
        item("old", ["Fix the settings page"], { searchRecency: 1 }),
        item("recent", ["Settings refactor"], { searchRecency: 2 }),
        item("other", ["Unrelated"], { searchRecency: 3 }),
      ],
    },
  ];

  it("keeps everything for an empty query", () => {
    expect(ids(filterSearchGroups(groups, ""))).toEqual([
      ["actions", ["new", "settings"]],
      ["threads", ["old", "recent", "other"]],
    ]);
  });

  it("requires every token and drops empty groups", () => {
    expect(ids(filterSearchGroups(groups, "new conv"))).toEqual([["actions", ["new"]]]);
    expect(ids(filterSearchGroups(groups, "nothing matches"))).toEqual([]);
  });

  it("ranks title matches first and, among thread titles, the more recent", () => {
    expect(ids(filterSearchGroups(groups, "settings"))).toEqual([
      ["actions", ["settings"]],
      ["threads", ["recent", "old"]],
    ]);
    // A match in a later field ranks below a title match.
    expect(
      ids(
        filterSearchGroups(
          [
            {
              value: "actions",
              label: "Actions",
              items: [item("desc", ["Open", "preferences"]), item("title", ["Preferences"])],
            },
          ],
          "pref",
        ),
      ),
    ).toEqual([["actions", ["title", "desc"]]]);
  });

  it("ranks secondary items last", () => {
    const result = filterSearchGroups(
      [
        {
          value: "actions",
          label: "Actions",
          items: [item("a", ["Theme"], { secondary: true }), item("b", ["Theme"])],
        },
      ],
      "theme",
    );
    expect(ids(result)).toEqual([["actions", ["b", "a"]]]);
  });

  it("searches only the actions after >", () => {
    expect(ids(filterSearchGroups(groups, ">settings"))).toEqual([["actions", ["settings"]]]);
    expect(ids(filterSearchGroups(groups, ">"))).toEqual([["actions", ["new", "settings"]]]);
  });
});
