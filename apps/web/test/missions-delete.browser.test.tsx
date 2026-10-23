// Deleting a mission or a slice from the missions view (docs/plans/agents.md,
// A3: D1395): asked first, through the command, and a refusal is shown.
import type { Dialogs } from "@jhin/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DeleteButton } from "../src/plugins/missions/edit.tsx";

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});
async function render(element: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

const dialogs = (answer: boolean) => {
  const asked: string[] = [];
  const service = {
    confirm: async (options: { title: string }) => {
      asked.push(options.title);
      return answer;
    },
  } as unknown as Dialogs;
  return { service, asked };
};

describe("Delete mission / Delete slice (D1395)", () => {
  it("deletes only once confirmed, then tells the page", async () => {
    const ask = dialogs(true);
    const ran: string[] = [];
    const done = Promise.withResolvers<void>();
    await render(
      <DeleteButton
        description="Gone."
        dialogs={ask.service}
        label="Delete slice"
        onDone={() => done.resolve()}
        run={async () => void ran.push("slices.delete")}
        title="Delete Roof?"
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Delete slice" }));
    await done.promise;
    expect(ask.asked).toEqual(["Delete Roof?"]);
    expect(ran).toEqual(["slices.delete"]);
  });

  it("does nothing when cancelled, and shows the command's refusal", async () => {
    const cancel = dialogs(false);
    const ran: string[] = [];
    await render(
      <DeleteButton
        description="Gone."
        dialogs={cancel.service}
        label="Delete slice"
        run={async () => void ran.push("x")}
        title="Delete Roof?"
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Delete slice" }));
    // Let the declined confirmation settle: the button is still there, nothing ran.
    await act(async () => undefined);
    expect(cancel.asked).toEqual(["Delete Roof?"]);
    expect(ran).toEqual([]);
    await unmount?.();

    const refused = dialogs(true);
    await render(
      <DeleteButton
        description="Gone."
        dialogs={refused.service}
        label="Delete slice"
        run={() => Promise.reject(new Error("Slice s2 depends on this one"))}
        title="Delete Roof?"
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Delete slice" }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("Slice s2 depends on this one");
  });

  it("is not offered without a dialog host", async () => {
    await render(
      <DeleteButton
        description="Gone."
        dialogs={undefined}
        label="Delete mission"
        run={async () => undefined}
        title="Delete M?"
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Delete mission" }))
      .not.toBeInTheDocument();
  });
});
