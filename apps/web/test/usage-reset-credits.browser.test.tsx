// An account's reset credits on the Usage page (t3-parity.md D1655, D1656): "Use reset" asks
// through the dialogs service, redeems through the node command, says what it did and has the
// page read the limits again.
import type { AgentResetCredits } from "@jhin/agent-api";
import type { ThreadsCatalog } from "@jhin/client-api";
import { DialogHost, createDialogs } from "@jhin/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import type { LimitAccount } from "../src/lib/usage-pools.ts";
import { ResetCredits } from "../src/plugins/usage-page.tsx";

/**
 * The dialog's buttons are clicked through the DOM: the modal's inert backdrop takes the
 * pointer in browser mode, as for the pull request's merge dialog.
 */
const press = (button: Locator) => act(async () => (button.element() as HTMLElement).click());

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

const NOW = Date.parse("2030-01-01T00:00:00Z");
const account: LimitAccount = {
  key: "laptop|jhin.agent-codex",
  agentId: "jhin.agent-codex",
  agentName: "Codex",
  nodeLabel: "laptop",
  target: { node: "laptop" },
  limits: { checkedAt: "2030-01-01T00:00:00Z", windows: [] },
};

/** The page's part: a dialog host, and the credits as the latest read reported them. */
async function render(threads: ThreadsCatalog, credits: AgentResetCredits) {
  const dialogs = createDialogs();
  const redeemed: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const show = (shown: AgentResetCredits) =>
    act(async () =>
      root.render(
        <>
          <ResetCredits
            account={account}
            credits={shown}
            dialogs={dialogs}
            now={NOW}
            redeemed={() => redeemed.push("read again")}
            showName={false}
            threads={threads}
          />
          <DialogHost dialogs={dialogs} />
        </>,
      ),
    );
  await show(credits);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { show, redeemed };
}

describe("the Usage page's reset credits (D1655, D1656)", () => {
  it("asks first, redeems, says what it did and reads the limits again", async () => {
    const calls: unknown[] = [];
    const answer = Promise.withResolvers<{ outcome: string }>();
    const threads = {
      call: (target: unknown, method: string, params: unknown) => {
        calls.push([target, method, params]);
        return answer.promise;
      },
    } as unknown as ThreadsCatalog;
    const { show, redeemed } = await render(threads, {
      availableCount: 1,
      nextExpiresAt: "2030-01-03T05:00:00Z",
    });
    await expect
      .element(page.getByText("1 reset credit banked · next expires in 2d 5h"))
      .toBeVisible();

    // Cancelled: nothing is spent.
    await userEvent.click(page.getByRole("button", { name: "Use reset" }));
    const confirm = page.getByRole("alertdialog", { name: "Use a reset credit?" });
    await expect
      .element(
        confirm.getByText(
          "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
        ),
      )
      .toBeVisible();
    await press(confirm.getByRole("button", { name: "Cancel" }));
    await expect.element(confirm).not.toBeInTheDocument();
    expect(calls).toEqual([]);

    await userEvent.click(page.getByRole("button", { name: "Use reset" }));
    await press(confirm.getByRole("button", { name: "Use credit" }));
    await expect.element(page.getByRole("button", { name: "Using…" })).toBeDisabled();
    expect(calls).toEqual([
      [{ node: "laptop" }, "agents.reset-credit.consume", { agentId: "jhin.agent-codex" }],
    ]);
    answer.resolve({ outcome: "reset" });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Reset applied. Your windows have cleared.");
    expect(redeemed).toEqual(["read again"]);

    // The limits read again report none left: it says so beside the result, with no button.
    await show({ availableCount: 0 });
    await expect.element(page.getByText("No reset credits banked")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Use reset" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Reset applied. Your windows have cleared.");
  });

  it("says when the credit could not be used, and shows nothing with none banked", async () => {
    const threads = {
      call: () => Promise.reject(new Error("Codex could not redeem the reset credit.")),
    } as unknown as ThreadsCatalog;
    const { show, redeemed } = await render(threads, { availableCount: 0 });
    await expect.element(page.getByText("No reset credits banked")).not.toBeInTheDocument();

    await show({ availableCount: 2 });
    await expect.element(page.getByText("2 reset credits banked")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use reset" }));
    await press(page.getByRole("alertdialog").getByRole("button", { name: "Use credit" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Could not use the reset credit.");
    expect(redeemed).toEqual(["read again"]);
  });
});
