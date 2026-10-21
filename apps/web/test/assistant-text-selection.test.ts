import { describe, expect, it } from "vite-plus/test";

import {
  createAssistantTextSelector,
  findAssistantCitationText,
} from "../src/lib/assistant-text-selection.ts";

describe("a quote's place in an agent's message (T3's text selectors, D1010)", () => {
  const text = "Use  a cache.\nThen use a cache again.";
  it("is its folded offsets and the text around it", () => {
    const start = text.indexOf("a cache");
    expect(createAssistantTextSelector(text, start, start + 7)).toEqual({
      text: "a cache",
      start: 4,
      end: 11,
      prefix: "Use ",
      suffix: ". Then use a cache again.",
    });
    expect(createAssistantTextSelector(text, 3, 5)).toBeNull();
  });

  it("is found again by its context, even when the offsets drifted", () => {
    const later = text.lastIndexOf("a cache");
    const selector = createAssistantTextSelector(text, later, later + 7)!;
    expect(findAssistantCitationText(text, selector)).toEqual({ start: 22, end: 29 });
    expect(findAssistantCitationText(`Intro. ${text}`, { ...selector, start: 0, end: 7 })).toEqual({
      start: 29,
      end: 36,
    });
    expect(findAssistantCitationText("nothing here", selector)).toBeNull();
  });
});
