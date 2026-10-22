import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { type PutAside, usePutAside } from "../src/plugins/chat/put-aside.ts";

interface Props {
  draftKey: string;
  seed: { key: string; text: string } | undefined;
  asking: boolean;
}

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

/** The hook in a composer of one text, as the chat's composer holds it. */
function mount(initial: string, props: Props) {
  const state: { prompt: string; aside: PutAside | undefined; saved: string[] } = {
    prompt: initial,
    aside: undefined,
    saved: [],
  };
  let setProps: ((props: Props) => void) | undefined;
  let type: ((value: string) => void) | undefined;
  function Harness() {
    const [current, setCurrent] = useState(props);
    const [prompt, setPrompt] = useState(initial);
    setProps = setCurrent;
    type = setPrompt;
    const aside = usePutAside({ ...current, prompt, setPrompt });
    state.prompt = prompt;
    state.aside = aside;
    // The composer saves its text as the draft only while nothing is aside.
    if (!aside.active && state.saved.at(-1) !== prompt) state.saved.push(prompt);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return {
    state,
    set: (next: Props) => act(() => setProps!(next)),
    type: (value: string) => act(() => type!(value)),
  };
}

const ask = (key: string, text: string): Props => ({
  draftKey: "t1",
  seed: { key, text },
  asking: true,
});
const idle: Props = { draftKey: "t1", seed: undefined, asking: false };

describe("the draft a prefilled answer puts aside (D1001)", () => {
  it("shows the answer instead, never saves it, and brings the draft back after", () => {
    const composer = mount("my draft", idle);
    composer.set(ask("r1:q1", "Dear team,"));
    expect(composer.state.prompt).toBe("Dear team,");
    expect(composer.state.aside?.active).toBe(true);
    composer.type("Dear team, hello");

    composer.set(idle);
    expect(composer.state.prompt).toBe("my draft");
    expect(composer.state.aside?.active).toBe(false);
    expect(composer.state.saved).toEqual(["my draft"]);
  });

  it("keeps the first draft aside across the request's questions, prefilled or not", () => {
    const composer = mount("my draft", idle);
    composer.set(ask("r1:q1", "first"));
    composer.set(ask("r1:q2", "second"));
    expect(composer.state.prompt).toBe("second");
    // A question without an answer to edit: what is typed is its answer, not the draft.
    composer.type("");
    composer.set({ draftKey: "t1", seed: undefined, asking: true });
    composer.type("an answer");
    expect(composer.state.saved).toEqual(["my draft"]);
    composer.set(idle);
    expect(composer.state.prompt).toBe("my draft");
  });

  it("takes another device's draft aside instead of over the answer", () => {
    const composer = mount("my draft", idle);
    expect(composer.state.aside?.takeRemote("elsewhere")).toBe(false);
    composer.set(ask("r1:q1", "answer"));
    expect(composer.state.aside?.takeRemote("from my phone")).toBe(true);
    expect(composer.state.prompt).toBe("answer");
    composer.set(idle);
    expect(composer.state.prompt).toBe("from my phone");
  });

  it("gives another draft nothing of this one", () => {
    const composer = mount("my draft", idle);
    composer.set(ask("r1:q1", "answer"));
    composer.set({ draftKey: "t2", seed: undefined, asking: false });
    expect(composer.state.prompt).toBe("answer");
    expect(composer.state.aside?.active).toBe(false);
  });
});
