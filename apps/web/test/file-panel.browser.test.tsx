import { toDisposable, type PluginContext } from "@jhin/sdk";
import type { NodeCatalog, NodeTarget } from "@jhin/client-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { DiffSettings } from "../src/lib/settings.ts";
import { useAgentSkills } from "../src/plugins/chat/agent-skills.ts";
import { FilePanel } from "../src/plugins/chat/file-panel.tsx";
import { ChatContext, type ChatServices } from "../src/plugins/chat/services.ts";

const target: NodeTarget = { node: "ws://a/rpc" };

const catalog = {
  projects: [{ id: "p1", name: "acme", path: "/w/acme" }],
  threads: [{ id: "t1", projectId: "p1", title: "Thread" }],
} as unknown as NodeCatalog;

/** A node whose answers the test gives: each call waits until the test settles it. */
function fakeNode() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  const call = (_target: NodeTarget, method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    calls,
    call,
    /** Settles the oldest call still waiting. */
    async answer(value: unknown) {
      await act(async () => pending.shift()!.resolve(value));
    },
    async fail(error: unknown) {
      await act(async () => pending.shift()!.reject(error));
    },
  };
}

function services(node: ReturnType<typeof fakeNode>, nodeCatalog: NodeCatalog | undefined) {
  const context = {
    config: {
      get: () => DiffSettings.parse({}),
      onDidChange: () => toDisposable(() => undefined),
    },
  } as unknown as PluginContext;
  return {
    context,
    settings: { values: () => ({}), patch: () => undefined, reset: () => undefined },
    threads: {
      call: node.call,
      catalog: () => nodeCatalog,
      subscribe: () => toDisposable(() => undefined),
    },
  } as unknown as ChatServices;
}

const encode = (text: string) => btoa(text);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mount(element: React.ReactElement, chat: ChatServices) {
  const container = document.createElement("div");
  container.style.height = "600px";
  container.style.display = "flex";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ChatContext.Provider value={chat}>{element}</ChatContext.Provider>),
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
}

describe("the file panel (D1342)", () => {
  it("reads the thread's file, shows its breadcrumbs, and closes", async () => {
    const node = fakeNode();
    const closed: string[] = [];
    await mount(
      <FilePanel
        onClose={() => closed.push("closed")}
        path="src/lib/app.ts"
        projectId={undefined}
        target={target}
        threadId="t1"
      />,
      services(node, catalog),
    );
    await expect.element(page.getByRole("status", { name: "Loading file" })).toBeVisible();
    expect(node.calls).toEqual([
      {
        method: "projects.read-file",
        params: { projectId: "p1", threadId: "t1", path: "src/lib/app.ts", maxBytes: 1048577 },
      },
    ]);
    await node.answer({
      path: "src/lib/app.ts",
      sizeBytes: 26,
      data: encode("export const port = 8080;\n"),
      truncated: false,
    });
    const panel = page.getByRole("complementary", { name: "File preview" });
    await expect.element(panel.getByText("export const port = 8080;")).toBeVisible();
    // T3's breadcrumbs: the project, then each folder.
    for (const crumb of ["acme", "src", "lib"]) {
      await expect.element(panel.getByText(crumb, { exact: true })).toBeVisible();
    }
    await panel.getByRole("button", { name: "Close app.ts" }).click();
    expect(closed).toEqual(["closed"]);
  });

  it("says why a read failed, and reads again on Try again", async () => {
    const node = fakeNode();
    await mount(
      <FilePanel
        onClose={() => undefined}
        path="docs/missing.md"
        projectId="p1"
        target={target}
        threadId={undefined}
      />,
      services(node, catalog),
    );
    await node.fail(new Error("No such file"));
    await expect.element(page.getByRole("alert").getByText("No such file")).toBeVisible();
    await expect.element(page.getByText("docs/missing.md", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    expect(node.calls).toHaveLength(2);
    // A draft's project is asked with no thread.
    expect(node.calls[1]!.params).toMatchObject({ projectId: "p1", path: "docs/missing.md" });
    expect(node.calls[1]!.params).not.toHaveProperty("threadId");
    await node.answer({
      path: "docs/missing.md",
      sizeBytes: 5,
      data: encode("# Hi\n"),
      truncated: false,
    });
    await expect.element(page.getByRole("heading", { name: "Hi" })).toBeVisible();
  });

  it("reads media whole, and says when it is too large", async () => {
    const node = fakeNode();
    await mount(
      <FilePanel
        onClose={() => undefined}
        path="clip.mp4"
        projectId="p1"
        target={target}
        threadId={undefined}
      />,
      services(node, catalog),
    );
    expect(node.calls[0]!.params).toMatchObject({ maxBytes: 50 * 1024 * 1024, whole: true });
    await node.fail(Object.assign(new Error("too large"), { code: "FILE_TOO_LARGE" }));
    await expect
      .element(page.getByRole("alert").getByText("clip.mp4 is too large to preview."))
      .toBeVisible();
  });

  it("says so when the thread's project is not known", async () => {
    const node = fakeNode();
    await mount(
      <FilePanel
        onClose={() => undefined}
        path="a.ts"
        projectId={undefined}
        target={target}
        threadId="gone"
      />,
      services(node, catalog),
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This file's project is not available.");
    expect(node.calls).toEqual([]);
  });
});

function Skills(props: { asking: string | undefined; node: ReturnType<typeof fakeNode> }) {
  const skills = useAgentSkills(
    { call: props.node.call as ChatServices["threads"]["call"] },
    target,
    "p1",
    "agent-1",
    props.asking,
  );
  return <p>skills: {skills.map((skill) => skill.name).join(",")}</p>;
}

describe("a sent message's skills (D1341)", () => {
  it("are asked only while a message names one, and again after a failure", async () => {
    const node = fakeNode();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    const render = (asking: string | undefined) =>
      act(async () => root.render(<Skills asking={asking} node={node} />));
    await render(undefined);
    expect(node.calls).toEqual([]);

    await render("turn-1");
    expect(node.calls).toEqual([
      { method: "agents.commands", params: { projectId: "p1", agentId: "agent-1" } },
    ]);
    // Another message naming one while the ask is on its way waits for it.
    await render("turn-1 turn-1b");
    expect(node.calls).toHaveLength(1);
    await node.fail(new Error("not connected"));
    await expect.element(page.getByText("skills:", { exact: true })).toBeVisible();

    // A failure is not kept: the next message naming one asks again.
    await render("turn-1 turn-2");
    expect(node.calls).toHaveLength(2);
    await node.answer({ commands: [], skills: [{ name: "deploy", path: "/s/SKILL.md" }] });
    await expect.element(page.getByText("skills: deploy")).toBeVisible();
    await render("turn-1 turn-2 turn-3");
    expect(node.calls).toHaveLength(2);
  });
});
