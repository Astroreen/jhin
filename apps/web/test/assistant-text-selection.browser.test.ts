import type { AssistantCitation } from "@jhin/agent-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  captureAssistantTextSelection,
  revealAssistantCitation,
} from "../src/lib/assistant-text-selection.ts";
import { citationSource } from "../src/lib/composer-context.ts";

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

/** The thread view's markers around one agent message of two paragraphs and a button. */
function message(): { viewport: HTMLElement; first: Text; second: Text; strong: Text } {
  const viewport = document.createElement("div");
  viewport.dataset["assistantCitationViewport"] = "";
  viewport.dataset["assistantCitationNode"] = "n";
  viewport.innerHTML =
    '<article data-assistant-citation-source="m" data-assistant-citation-thread="t">' +
    "<p>Use  a cache.</p><p>Then <strong>use</strong> a cache again.</p>" +
    "<button>Copy</button></article>";
  document.body.append(viewport);
  const [p1, p2] = viewport.querySelectorAll("p");
  return {
    viewport,
    first: p1!.firstChild as Text,
    second: p2!.lastChild as Text,
    strong: p2!.querySelector("strong")!.firstChild as Text,
  };
}

function select(start: Node, startOffset: number, end: Node, endOffset: number): Selection {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("a selection in an agent's message as a quote (D1012)", () => {
  it("reads a selection across blocks and text nodes in the message's folded text", () => {
    const { viewport, first, strong } = message();
    // From "a cache." in the first paragraph to "use" in the second's <strong>.
    const captured = captureAssistantTextSelection(viewport, select(first, 5, strong, 3));
    expect(captured?.source.dataset["assistantCitationSource"]).toBe("m");
    expect(captured?.selector).toEqual({
      text: "a cache.\nThen use",
      start: 4,
      end: 21,
      prefix: "Use ",
      suffix: " a cache again.",
    });
  });

  it("offers nothing for the message's own controls or outside the messages", () => {
    const { viewport } = message();
    const button = viewport.querySelector("button")!.firstChild!;
    expect(captureAssistantTextSelection(viewport, select(button, 0, button, 4))).toBeNull();
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    const text = outside.firstChild!;
    expect(captureAssistantTextSelection(viewport, select(text, 0, text, 4))).toBeNull();
  });
});

describe("Go to source (D1011)", () => {
  const quote = (nodeId: string): AssistantCitation => ({
    version: 1,
    nodeId,
    threadId: "t",
    messageId: "m",
    text: "use a cache",
    start: 14,
    end: 25,
    prefix: "Use a cache. Then ",
    suffix: " again.",
  });

  it("selects the quote in its message on screen, found by its context", () => {
    const { second } = message();
    expect(revealAssistantCitation(document, quote("n"))).toBe(true);
    expect(document.getSelection()?.toString()).toBe("use a cache");
    expect(document.getSelection()?.getRangeAt(0).endContainer).toBe(second);
  });

  it("opens the quote's thread when its node's message is not on screen", () => {
    message();
    const opened: string[] = [];
    const show = citationSource({ openThread: (href) => opened.push(href) > 0 }, (citation) =>
      revealAssistantCitation(document, citation),
    );
    // Another node's thread with the same ids is not the quote's.
    show(quote("other node"));
    expect(opened).toEqual(["jhin://other%20node/threads/t"]);
    expect(document.getSelection()?.toString()).toBe("");
  });
});
