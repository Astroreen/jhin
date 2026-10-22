// The Lineage section's paging (docs/plans/t3-parity.md, D802): six rows, then twelve more at a time.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { LineageRowList, type LineageRow } from "../src/plugins/chat/lineage.tsx";

describe("LineageRowList", () => {
  it("shows six rows, then twelve more at a time, saying how many come", async () => {
    const rows: LineageRow[] = Array.from({ length: 20 }, (_, index) => ({
      threadId: `fork-${index + 1}`,
      relationship: "fork",
      thread: undefined,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <LineageRowList rows={rows}>
          {(row) => <li key={row.threadId}>{row.threadId}</li>}
        </LineageRowList>,
      ),
    );
    const items = page.getByRole("list", { name: "Related threads" }).getByRole("listitem");
    expect(items.elements()).toHaveLength(6);
    await userEvent.click(page.getByRole("button", { name: "Show 12 more" }));
    await expect.element(items.nth(17)).toHaveTextContent("fork-18");
    expect(items.elements()).toHaveLength(18);
    await userEvent.click(page.getByRole("button", { name: "Show 2 more" }));
    await expect.element(items.nth(19)).toHaveTextContent("fork-20");
    await expect
      .element(page.getByRole("button", { name: /Show \d+ more/ }))
      .not.toBeInTheDocument();
    await act(async () => root.unmount());
    host.remove();
  });
});
