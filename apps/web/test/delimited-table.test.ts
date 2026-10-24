// T3's CSV and TSV table (t3-parity.md D1436): its delimiter and its parse, quotes and limits.
import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewDelimiter,
  parseDelimitedPreview,
} from "../src/plugins/chat/delimited-table.tsx";

describe("delimited tables", () => {
  it("knows a CSV or TSV by its type, else its name", () => {
    expect(filePreviewDelimiter({ name: "a.bin", mimeType: "text/csv" })).toBe(",");
    expect(filePreviewDelimiter({ name: "a.tsv" })).toBe("\t");
    expect(filePreviewDelimiter({ name: "a.csv", mimeType: "image/png" })).toBeNull();
    expect(filePreviewDelimiter({ name: "a.txt" })).toBeNull();
  });

  it("reads quoted cells and cuts at T3's limits", () => {
    expect(parseDelimitedPreview('﻿name,note\r\nAda,"says ""hi"", twice"\n', ",")).toEqual({
      rows: [
        ["name", "note"],
        ["Ada", 'says "hi", twice'],
      ],
      truncated: false,
    });
    const wide = Array.from({ length: 31 }, (_, index) => `c${index}`).join("\t");
    expect(parseDelimitedPreview(wide, "\t").truncated).toBe(true);
    const long = Array.from({ length: 101 }, (_, index) => `${index}`).join("\n");
    const parsed = parseDelimitedPreview(long, ",");
    expect(parsed.rows).toHaveLength(100);
    expect(parsed.truncated).toBe(true);
  });
});
