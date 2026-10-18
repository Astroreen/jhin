import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { Slot, SlotsProvider, createSlotRegistry } from "../src/index.ts";

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

const Label = (text: string) => () => <span>{text}</span>;
const texts = (container: HTMLElement) =>
  [...container.querySelectorAll("span")].map((span) => span.textContent);

describe("slots", () => {
  it("renders contributions by order then id, and follows rules to hide and reorder", () => {
    const registry = createSlotRegistry();
    registry.contribute("bar", { id: "b", component: Label("B") });
    registry.contribute("bar", { id: "a", component: Label("A") });
    const late = registry.contribute("bar", { id: "z", order: -1, component: Label("Z") });
    const view = mount(
      <SlotsProvider registry={registry}>
        <Slot name="bar" />
      </SlotsProvider>,
    );
    expect(texts(view.container)).toEqual(["Z", "A", "B"]);

    act(() => registry.setRules({ hide: ["a"], order: { bar: ["b"] } }));
    expect(texts(view.container)).toEqual(["B", "Z"]);

    act(() => late.dispose());
    expect(texts(view.container)).toEqual(["B"]);
    view.unmount();
  });

  it("keeps the page alive when a contribution throws", () => {
    const registry = createSlotRegistry();
    registry.contribute("bar", {
      id: "broken",
      component: () => {
        throw new Error("plugin bug");
      },
    });
    registry.contribute("bar", { id: "fine", component: Label("fine") });
    const errors = console.error;
    console.error = () => undefined;
    const view = mount(
      <SlotsProvider registry={registry}>
        <Slot name="bar" />
      </SlotsProvider>,
    );
    console.error = errors;

    expect(view.container.querySelector("[data-contribution-error=broken]")?.textContent).toBe(
      "broken failed to render",
    );
    expect(texts(view.container)).toEqual(["fine"]);
    view.unmount();
  });
});
