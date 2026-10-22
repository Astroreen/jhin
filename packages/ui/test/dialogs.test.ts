import { describe, expect, it } from "vite-plus/test";

import { createDialogs } from "../src/services.tsx";

type Dialogs = ReturnType<typeof createDialogs>;
const shownId = (dialogs: Dialogs) => {
  const state = dialogs.state();
  return state.status === "idle" ? undefined : state.request.id;
};

describe("dialogs", () => {
  it("shows one request at a time and answers each exactly once", async () => {
    const dialogs = createDialogs();
    dialogs.register();
    const first = dialogs.confirm({ title: "Delete?" });
    const second = dialogs.prompt({ title: "Rename" });
    const third = dialogs.prompt({ title: "Rename" });

    expect(dialogs.state()).toMatchObject({ status: "open", request: { kind: "confirm" } });
    dialogs.respond(true);
    // A second answer to the same request changes nothing.
    dialogs.respond(false);
    expect(await first).toBe(true);
    expect(dialogs.state().status).toBe("closing");

    dialogs.closed();
    expect(dialogs.state()).toMatchObject({ status: "open", request: { kind: "prompt" } });
    const secondId = shownId(dialogs);
    dialogs.respond("New name");
    dialogs.closed();
    expect(await second).toBe("New name");

    // The next prompt with the same title is a request of its own (a fresh form).
    expect(shownId(dialogs)).not.toBe(secondId);
    dialogs.respond(undefined);
    expect(await third).toBeUndefined();
  });

  it("chooses between two ways to agree, and keeps a plain confirmation to one", async () => {
    const dialogs = createDialogs();
    dialogs.register();
    const both = dialogs.choose({
      title: "Edit from here?",
      confirmLabel: "Revert and keep changes",
      alternativeLabel: "Revert files too",
    });
    expect(dialogs.state()).toMatchObject({
      request: { options: { alternativeLabel: "Revert files too" } },
    });
    dialogs.respond("alternative");
    expect(await both).toBe("alternative");
    dialogs.closed();

    const plain = dialogs.confirm({ title: "Delete?", alternativeLabel: "Not shown" });
    const state = dialogs.state();
    expect(state.status === "idle" ? undefined : state.request.options).not.toHaveProperty(
      "alternativeLabel",
    );
    dialogs.respond(true);
    expect(await plain).toBe(true);
    dialogs.closed();

    const cancelled = dialogs.choose({ title: "Edit from here?", alternativeLabel: "Too" });
    dialogs.respond(false);
    expect(await cancelled).toBeUndefined();
  });

  it("answers at once while no host shows them, and answers the rest when the last host goes", async () => {
    const dialogs = createDialogs();
    expect(await dialogs.confirm({ title: "Nobody sees this" })).toBe(false);

    const unregister = dialogs.register();
    const open = dialogs.confirm({ title: "Open" });
    const queued = dialogs.prompt({ title: "Queued" });
    unregister();
    expect(await open).toBe(false);
    expect(await queued).toBeUndefined();
    expect(dialogs.state().status).toBe("idle");
  });

  it("tells watchers of every change, and stops when they unsubscribe", () => {
    const dialogs = createDialogs();
    dialogs.register();
    let seen = 0;
    const stop = dialogs.watch(() => (seen += 1));
    void dialogs.confirm({ title: "One" });
    dialogs.respond(true);
    expect(seen).toBe(2);
    stop();
    dialogs.closed();
    expect(seen).toBe(2);
  });
});
