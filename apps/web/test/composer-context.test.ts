import { describe, expect, it } from "vite-plus/test";

import { planContextInsertion, terminalContextRecord } from "../src/lib/composer-context.ts";

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
