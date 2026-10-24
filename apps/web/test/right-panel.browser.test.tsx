// The right panel's strip in a browser (t3-parity.md D1422): T3's tabs, their menu, "Add panel
// surface" and "Open a surface" with their letters.
import type { RightPanelState, RightPanelSurface, RightPanelSurfaceKind } from "@jhin/client-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { RightPanelView, type RightPanelViewProps } from "../src/plugins/right-panel/panel.tsx";
import { surfaceOf } from "../src/plugins/right-panel/store.ts";

const Icon = (props: { className?: string }) => <svg className={props.className} />;

const kinds: readonly RightPanelSurfaceKind[] = [
  {
    id: "browser",
    title: "Browser",
    icon: Icon,
    offer: { label: "Browser", shortcut: "B", order: 10 },
    component: () => <p>browser body</p>,
  },
  {
    id: "diff",
    title: "Diff",
    icon: Icon,
    offer: {
      label: "Diff",
      shortcut: "D",
      order: 40,
      useAvailability: () => ({
        available: false,
        reason: "Diff is only available for server threads in Git repositories.",
        hint: "Available for Git repositories.",
      }),
    },
    component: () => <p>diff body</p>,
  },
  {
    id: "file",
    title: "File",
    icon: Icon,
    useTab: ({ surface }) => ({ title: surface.resource ?? "" }),
    menuItems: () => [{ id: "copy", label: "Copy path", onSelect: () => undefined }],
    component: ({ surface }) => <p>file {surface.resource}</p>,
  },
];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function state(surfaces: readonly RightPanelSurface[], activeId: string | null): RightPanelState {
  return { surfaces, activeId, open: true, maximized: false };
}

async function mount(panel: RightPanelState) {
  const calls: string[] = [];
  const container = document.createElement("div");
  container.style.height = "600px";
  container.style.width = "900px";
  container.style.display = "flex";
  container.style.position = "relative";
  document.body.append(container);
  const root = createRoot(container);
  const props: RightPanelViewProps = {
    place: { target: { node: "n" }, threadId: "t" },
    state: panel,
    kinds,
    kindKey: (id) => id,
    newSurfaceRequests: { current: () => 0, subscribe: () => () => undefined },
    onActivate: (surface) => calls.push(`activate ${surface.id}`),
    onAdd: (kind, option) =>
      calls.push(`add ${kind.id}${option === undefined ? "" : ` ${option}`}`),
    onClose: (id) => calls.push(`close ${id}`),
    onCloseOthers: (id) => calls.push(`close-others ${id}`),
    onCloseToRight: (id) => calls.push(`close-to-right ${id}`),
    onCloseAll: () => calls.push("close-all"),
    onMove: (id, index) => calls.push(`move ${id} ${index}`),
    onToggleMaximized: () => calls.push("maximize"),
    onError: (kind, error) => calls.push(`error ${kind} ${String(error)}`),
  };
  await act(async () => root.render(<RightPanelView {...props} />));
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return calls;
}

describe("the right panel's strip", () => {
  it("shows a tab per surface and the active one's body", async () => {
    const calls = await mount(
      state([surfaceOf("browser", "a"), surfaceOf("file", "src/a.ts")], "file:src/a.ts"),
    );
    const panel = page.getByRole("complementary", { name: "Right panel" });
    const strip = panel.getByRole("tablist", { name: "Panel surfaces" });
    await expect.element(strip.getByRole("tab", { name: "Browser" })).toBeVisible();
    await expect
      .element(strip.getByRole("tab", { name: "src/a.ts" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(panel.getByText("file src/a.ts")).toBeVisible();
    await strip.getByRole("tab", { name: "Browser" }).click();
    await strip.getByRole("button", { name: "Close src/a.ts" }).click();
    expect(calls).toEqual(["activate browser:a", "close file:src/a.ts"]);
  });

  it("offers T3's context menu, the kind's items first", async () => {
    const calls = await mount(
      state([surfaceOf("browser", "a"), surfaceOf("file", "src/a.ts")], "browser:a"),
    );
    await page.getByRole("tab", { name: "src/a.ts" }).click({ button: "right" });
    await expect.element(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
    // The last tab has none to its right.
    await expect
      .element(page.getByRole("menuitem", { name: "Close to the right" }))
      .toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Close others" }).click();
    expect(calls).toEqual(["close-others file:src/a.ts"]);
  });

  it("adds a surface from the menu, by its letter too, and says why one cannot be", async () => {
    const calls = await mount(state([surfaceOf("browser", "a")], "browser:a"));
    await page.getByRole("button", { name: "Add panel surface" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Diff" }))
      .toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("b");
    expect(calls).toEqual(["add browser"]);
  });

  it("opens a surface from the empty state, by its letter as T3's launcher", async () => {
    const calls = await mount(state([], null));
    const launcher = page.getByLabelText("Open a surface");
    await expect.element(launcher).toBeVisible();
    await expect.element(launcher).toHaveAttribute("data-surface-launcher-keys", "B");
    await userEvent.keyboard("b");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(calls).toEqual(["add browser", "add browser"]);
  });

  it("maximizes and restores the panel", async () => {
    const calls = await mount(state([surfaceOf("browser", "a")], "browser:a"));
    await page.getByRole("button", { name: "Maximize panel" }).click();
    expect(calls).toEqual(["maximize"]);
  });
});
