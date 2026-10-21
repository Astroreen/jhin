import { describe, expect, it } from "vite-plus/test";

import {
  type AssistantCitation,
  assistantCitationLabel,
  assistantCitationsToPlainText,
  formatAssistantCitationHref,
  parseAssistantCitationHref,
  projectMessageContext,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "../src/index.ts";

const citation: AssistantCitation = {
  version: 1,
  nodeId: "node 1",
  threadId: "t(1)",
  messageId: "m-1",
  text: "use a cache",
  start: 6,
  end: 17,
  prefix: "Echo: ",
  suffix: " today",
};

describe("a quote of an agent's message (D1010)", () => {
  it("is a link that holds it, read back as it was", () => {
    const href = formatAssistantCitationHref(citation);
    expect(href.startsWith("jhin-citation://v1/node%201/t%281%29/m-1?")).toBe(true);
    expect(parseAssistantCitationHref(href)).toEqual(citation);
    const commented = withAssistantCitationComment(citation, "  why?  ");
    expect(parseAssistantCitationHref(formatAssistantCitationHref(commented))).toEqual({
      ...citation,
      comment: "why?",
    });
    expect(withAssistantCitationComment(commented, " ")).toEqual(citation);
    // T3's checks: a blank quote, a backwards range, an extra parameter are no quote.
    expect(
      parseAssistantCitationHref(formatAssistantCitationHref({ ...citation, text: " " })),
    ).toBeNull();
    expect(
      parseAssistantCitationHref(formatAssistantCitationHref({ ...citation, end: 6 })),
    ).toBeNull();
    expect(parseAssistantCitationHref(`${href}&x=1`)).toBeNull();
  });

  it("shows its comment, else its text, and reads as plain text", () => {
    expect(assistantCitationLabel(citation)).toBe("use a cache");
    expect(assistantCitationLabel({ ...citation, comment: "why?" })).toBe("why?");
    const prompt = `see ${serializeAssistantCitation({ ...citation, comment: "why?" })} ok`;
    expect(assistantCitationsToPlainText(prompt)).toBe("see use a cache\nComment: why? ok");
  });

  it("reaches the agent as T3's [assistant-quote-n] and <assistant_citations> block", () => {
    const link = serializeAssistantCitation(citation);
    const read = projectMessageContext({ text: `Is ${link} right? Again ${link}.` });
    expect(read.startsWith("Is [assistant-quote-1] right? Again [assistant-quote-1].\n\n")).toBe(
      true,
    );
    expect(read).toContain("<assistant_citations>\nThe following excerpts were selected");
    expect(read).toContain('"text": "use a cache"');
    expect(read.endsWith("</assistant_citations>")).toBe(true);
  });
});
