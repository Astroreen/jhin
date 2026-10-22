import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { CiteSelection } from "../src/plugins/chat/cite-selection.tsx";

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.getSelection()?.removeAllRanges();
});

/** A messages scroller with one agent's answer, as the thread view renders it. */
function viewport(): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.height = "200px";
  scroller.style.overflowY = "auto";
  const answer = document.createElement("article");
  answer.dataset["assistantCitationSource"] = "message-1";
  answer.dataset["assistantCitationThread"] = "thread-1";
  const paragraph = document.createElement("p");
  paragraph.textContent = "Echo: cache the results";
  answer.append(paragraph);
  scroller.append(answer);
  document.body.append(scroller);
  return scroller;
}

function select(element: HTMLElement, text: string): void {
  const node = element.querySelector("p")!.firstChild as Text;
  const start = node.data.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

function mount(scroller: HTMLElement): void {
  const container = document.createElement("div");
  scroller.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <CiteSelection
        nodeId="node-1"
        onCite={async () => true}
        threadId="thread-1"
        viewport={{ current: scroller }}
      />,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    scroller.remove();
  };
}

describe("Cite on a selection in an agent's answer (D1012)", () => {
  it("offers Cite for a selection made before it loaded (D1043)", () => {
    // The view is a chunk of its own: a selection can come before it listens for one.
    const scroller = viewport();
    select(scroller, "the results");
    mount(scroller);
    expect(
      page.getByRole("button", { name: "Cite selection in composer", exact: true }).query(),
    ).not.toBeNull();
  });

  it("offers nothing for a collapsed selection at mount", () => {
    const scroller = viewport();
    const node = scroller.querySelector("p")!.firstChild as Text;
    document.getSelection()!.collapse(node, 3);
    mount(scroller);
    expect(page.getByRole("button", { name: /Cite selection/ }).query()).toBeNull();
  });
});
