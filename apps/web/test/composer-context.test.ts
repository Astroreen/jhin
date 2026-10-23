import { describe, expect, it } from "vite-plus/test";

import {
  contextRemovalRanges,
  draftContextsReader,
  planContextInsertion,
  terminalContextRecord,
} from "../src/lib/composer-context.ts";

const excerpt = (id: string) =>
  terminalContextRecord({
    id,
    terminalId: "t1",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 1,
    text: "$ ls",
  });
const reference = (id: string) => `[Terminal 1 line 1](jhin-context://v1/terminal/terminal_${id})`;

describe("putting a record into the prompt (D1009)", () => {
  it("goes at the caret, else at the end, a space before it only when the text runs up to it", () => {
    const one = excerpt("a");
    expect(
      planContextInsertion({ prompt: "why", caret: undefined, records: [], record: one }),
    ).toEqual({
      kind: "insert",
      records: [one],
      at: 3,
      text: ` ${reference("a")} `,
    });
    expect(
      planContextInsertion({ prompt: "why ", caret: 0, records: [], record: one }),
    ).toMatchObject({
      at: 0,
      text: `${reference("a")} `,
    });
  });

  it("counts only the records the prompt names towards T3's 200, and replaces one picked again", () => {
    const named = Array.from({ length: 200 }, (_, index) => excerpt(String(index)));
    const prompt = named.map((record) => reference(record.contextId.slice(9))).join(" ");
    expect(
      planContextInsertion({ prompt, caret: undefined, records: named, record: excerpt("new") }),
    ).toEqual({ kind: "full" });
    // Picked again: it replaces its own.
    expect(
      planContextInsertion({ prompt, caret: undefined, records: named, record: named[0]! }).kind,
    ).toBe("insert");
    // Records whose references are gone do not count.
    expect(
      planContextInsertion({ prompt: "", caret: undefined, records: named, record: excerpt("new") })
        .kind,
    ).toBe("insert");
  });
});

describe("taking a record's chips out of the prompt (D1286)", () => {
  it("finds each chip of the record, with the space after it, last first", () => {
    const prompt = `see ${reference("a")} and ${reference("b")} again ${reference("a")}`;
    const ranges = contextRemovalRanges(prompt, "terminal_a");
    expect(ranges).toHaveLength(2);
    let left = prompt;
    for (const { start, end } of ranges) left = left.slice(0, start) + left.slice(end);
    expect(left).toBe(`see and ${reference("b")} again `);
  });

  it("finds nothing for a record the prompt does not name", () => {
    expect(contextRemovalRanges(`see ${reference("a")}`, "terminal_z")).toEqual([]);
  });
});

describe("the records a draft names (chat.drafts 1.1, D1285)", () => {
  it("answers the same array for the same draft, only the records its prompt names", () => {
    const read = draftContextsReader();
    const draft = { prompt: `see ${reference("a")}`, contexts: [excerpt("a"), excerpt("b")] };
    const first = read(draft);
    expect(first.map((record) => record.contextId)).toEqual(["terminal_a"]);
    expect(read(draft)).toBe(first);
    expect(read({ ...draft })).not.toBe(first);
    expect(read(undefined)).toBe(read({ prompt: "nothing" }));
  });
});
