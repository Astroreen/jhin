import { toDisposable, type PluginContext } from "@jhin/sdk";
import type { NodeCatalog, NodeTarget } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { DiffSettings } from "../src/lib/settings.ts";
import { useAgentSkills } from "../src/plugins/chat/agent-skills.ts";
import { createFileEdits, useFilePending } from "../src/plugins/chat/file-edits.ts";
import { FilePanel, FilesPanel } from "../src/plugins/chat/file-panel.tsx";
import { createFileReveals } from "../src/plugins/chat/file-panel-route.ts";
import { ChatContext, type ChatServices } from "../src/plugins/chat/services.ts";

const target: NodeTarget = { node: "ws://a/rpc" };

const catalog = {
  projects: [{ id: "p1", name: "acme", path: "/w/acme" }],
  threads: [{ id: "t1", projectId: "p1", title: "Thread" }],
} as unknown as NodeCatalog;

/** A node whose answers the test gives: each call waits until the test settles it. */
function fakeNode() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const pending: {
    method: string;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }[] = [];
  const waiters: { method: string; arrived(params: Record<string, unknown>): void }[] = [];
  const call = (_target: NodeTarget, method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const result = new Promise((resolve, reject) => pending.push({ method, resolve, reject }));
    const index = waiters.findIndex((waiter) => waiter.method === method);
    if (index >= 0) waiters.splice(index, 1)[0]!.arrived(params);
    return result;
  };
  /** A call to `method` waits to be settled: now, or when the next one comes. */
  const arrival = async (method: string) => {
    if (pending.some((waiting) => waiting.method === method)) return;
    await new Promise((arrived) => waiters.push({ method, arrived }));
  };
  return {
    calls,
    call,
    /** Resolves with the params of the next call to `method`. */
    next: (method: string) =>
      new Promise<Record<string, unknown>>((arrived) => waiters.push({ method, arrived })),
    /** Settles the oldest call still waiting. */
    async answer(value: unknown) {
      await act(async () => pending.shift()!.resolve(value));
    },
    /** Settles the waiting call at `index` (0 the oldest), out of order. */
    async answerAt(index: number, value: unknown) {
      const [call] = pending.splice(index, 1);
      await act(async () => call!.resolve(value));
    },
    /** Settles the oldest waiting call to `method`, once one came. */
    async answerTo(method: string, value: unknown) {
      await arrival(method);
      const index = pending.findIndex((waiting) => waiting.method === method);
      const [call] = pending.splice(index, 1);
      await act(async () => call!.resolve(value));
    },
    async fail(error: unknown) {
      await act(async () => pending.shift()!.reject(error));
    },
    /** Fails the oldest waiting call to `method`, once one came. */
    async failTo(method: string, error: unknown) {
      await arrival(method);
      const index = pending.findIndex((waiting) => waiting.method === method);
      const [failed] = pending.splice(index, 1);
      await act(async () => failed!.reject(error));
    },
  };
}

/** The connection to the node, whose state the test changes (a reconnect). */
function fakeConnections() {
  const listeners = new Set<() => void>();
  let connection = {
    id: target.node,
    url: target.node,
    label: "a",
    client: {} as RpcClient,
    state: "open" as "open" | "connecting",
  };
  return {
    get: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    async set(state: "open" | "connecting") {
      connection = { ...connection, state };
      await act(async () => {
        for (const listener of Array.from(listeners)) listener();
      });
    },
  };
}

function services(
  node: ReturnType<typeof fakeNode>,
  nodeCatalog: NodeCatalog | undefined,
  connections = fakeConnections(),
) {
  const context = {
    config: {
      get: () => DiffSettings.parse({}),
      onDidChange: () => toDisposable(() => undefined),
    },
  } as unknown as PluginContext;
  return {
    context,
    settings: { values: () => ({}), patch: () => undefined, reset: () => undefined },
    fileReveals: createFileReveals(),
    fileEdits: createFileEdits(connections),
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

  it("says so for a thread the node's catalog does not have", async () => {
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
      .element(page.getByRole("alert").getByText("This file's thread is not available."))
      .toBeVisible();
    expect(node.calls).toEqual([]);
  });

  it("says so with neither a thread nor a project", async () => {
    const node = fakeNode();
    await mount(
      <FilePanel
        onClose={() => undefined}
        path="a.ts"
        projectId={undefined}
        target={target}
        threadId={undefined}
      />,
      services(node, catalog),
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This file's project is not available.");
    expect(node.calls).toEqual([]);
  });

  it("opens a project's file in the editor last chosen, or one chosen from its menu (D1429)", async () => {
    localStorage.removeItem("jhin.lastEditor");
    const node = fakeNode();
    await mount(
      <FilePanel
        embedded
        onClose={() => undefined}
        path="src/app.ts"
        projectId="p1"
        target={target}
        threadId={undefined}
      />,
      services(node, catalog),
    );
    await node.answerTo("projects.read-file", {
      path: "src/app.ts",
      sizeBytes: 26,
      data: encode("export const port = 8080;\n"),
      truncated: false,
    });
    await node.answerTo("editors.list", {
      editors: [
        { id: "vscode", label: "VS Code" },
        { id: "zed", label: "Zed" },
        { id: "file-manager", label: "Files" },
      ],
    });
    const openIn = page.getByRole("group", { name: "Open in editor" });
    await openIn.getByRole("button", { name: "Choose editor" }).click();
    const zed = page.getByRole("menuitem", { name: "Open in Zed" });
    await expect.element(zed).toBeVisible();
    // The node's file manager is not an editor.
    await expect
      .element(page.getByRole("menuitem", { name: "Open in Files" }))
      .not.toBeInTheDocument();
    await zed.click();
    await openIn.getByRole("button", { name: "Open file in preferred editor" }).click();
    const opened = node.calls.filter((call) => call.method === "editors.open");
    expect(opened.map((call) => call.params)).toEqual([
      { projectId: "p1", path: "src/app.ts", editor: "zed" },
      { projectId: "p1", path: "src/app.ts", editor: "zed" },
    ]);
    expect(localStorage.getItem("jhin.lastEditor")).toBe("zed");
    localStorage.removeItem("jhin.lastEditor");
  });
});

/** What the file's tab draws its dot from (D1645). */
function TabDot(props: { place: { target: NodeTarget; projectId?: string; threadId?: string } }) {
  const chat = useContext(ChatContext)!;
  const pending = useFilePending(chat.fileEdits, props.place, "docs/tasks.md");
  return pending ? <span aria-label="Unsaved changes" role="status" /> : null;
}

describe("editing a project's file (D1645–D1648)", () => {
  const tasks = "# Tasks\n\n- [ ] ship\n- [x] test\n";

  async function tasksFile(connections = fakeConnections()) {
    const node = fakeNode();
    const toasts: { title: string }[] = [];
    const chat = {
      ...services(node, catalog, connections),
      toasts: { show: (toast: { title: string }) => toasts.push(toast) },
    } as unknown as ChatServices;
    await mount(
      <>
        <TabDot place={{ target, projectId: "p1" }} />
        <FilePanel
          embedded
          onClose={() => undefined}
          path="docs/tasks.md"
          projectId="p1"
          target={target}
          threadId={undefined}
        />
      </>,
      chat,
    );
    await node.answerTo("projects.read-file", {
      path: "docs/tasks.md",
      sizeBytes: tasks.length,
      data: encode(tasks),
      truncated: false,
    });
    await node.answerTo("editors.list", { editors: [] });
    return { node, toasts };
  }
  const dot = page.getByRole("status", { name: "Unsaved changes" });
  const ship = page.getByRole("checkbox", { name: "Toggle task" }).first();

  it("ticks a task box, which writes the file, the dot showing until the write succeeds", async () => {
    const { node } = await tasksFile();
    await expect.element(ship).not.toBeChecked();
    await expect.element(dot).not.toBeInTheDocument();
    const write = node.next("projects.write-file");
    await ship.click();
    await expect.element(ship).toBeChecked();
    await expect.element(dot).toBeInTheDocument();
    expect(await write).toEqual({
      projectId: "p1",
      path: "docs/tasks.md",
      contents: "# Tasks\n\n- [x] ship\n- [x] test\n",
    });
    // Written: the file is read again, and the dot goes.
    const reread = node.next("projects.read-file");
    await node.answerTo("projects.write-file", { path: "docs/tasks.md" });
    await reread;
    await expect.element(dot).not.toBeInTheDocument();
    await node.answerTo("projects.read-file", {
      path: "docs/tasks.md",
      sizeBytes: tasks.length,
      data: encode("# Tasks\n\n- [x] ship\n- [x] test\n"),
      truncated: false,
    });
    await expect.element(ship).toBeChecked();
  });

  it("keeps the edits of a read-only connection, and writes them when it connects again", async () => {
    const connections = fakeConnections();
    const { node, toasts } = await tasksFile(connections);
    const write = node.next("projects.write-file");
    await ship.click();
    await write;
    // The node's answer to a token without `projects.write`.
    await node.failTo(
      "projects.write-file",
      Object.assign(new Error("Caller lacks projects.write for projects.write-file"), {
        code: "PERMISSION_DENIED",
      }),
    );
    expect(toasts).toEqual([]);
    await expect
      .element(
        page.getByText("Read-only connection. Unsaved edits are kept until write access returns."),
      )
      .toBeVisible();
    // The text stays as ticked, its boxes disabled (no "Toggle task"), and the file still pending.
    const box = page.getByRole("checkbox").first();
    await expect.element(box).toBeChecked();
    await expect.element(box).toBeDisabled();
    await expect.element(ship).not.toBeInTheDocument();
    await expect.element(dot).toBeInTheDocument();
    const again = node.next("projects.write-file");
    await connections.set("connecting");
    await connections.set("open");
    expect(await again).toMatchObject({ contents: "# Tasks\n\n- [x] ship\n- [x] test\n" });
    await expect
      .element(page.getByText("Read-only connection.", { exact: false }))
      .not.toBeInTheDocument();
    await node.answerTo("projects.write-file", { path: "docs/tasks.md" });
    await expect.element(dot).not.toBeInTheDocument();
  });

  it("takes the text on disk when a turn ends while nothing is pending", async () => {
    const node = fakeNode();
    const listeners = new Set<() => void>();
    let current = {
      ...catalog,
      threads: [
        {
          id: "t1",
          projectId: "p1",
          title: "Thread",
          lastTurn: { turnId: "u1", status: "running" },
        },
      ],
    } as unknown as NodeCatalog;
    const chat = {
      ...services(node, current),
      threads: {
        call: node.call,
        catalog: () => current,
        subscribe: (_target: NodeTarget, listener: () => void) => {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      },
    } as unknown as ChatServices;
    await mount(
      <FilePanel
        embedded
        onClose={() => undefined}
        path="src/app.ts"
        projectId={undefined}
        target={target}
        threadId="t1"
      />,
      chat,
    );
    await node.answerTo("projects.read-file", {
      path: "src/app.ts",
      sizeBytes: 26,
      data: encode("export const port = 8080;\n"),
      truncated: false,
    });
    const panel = page.getByRole("region", { name: "File preview" });
    await expect.element(panel.getByText("8080")).toBeVisible();
    const reread = node.next("projects.read-file");
    current = {
      ...current,
      threads: [
        {
          id: "t1",
          projectId: "p1",
          title: "Thread",
          lastTurn: { turnId: "u1", status: "completed" },
        },
      ],
    } as unknown as NodeCatalog;
    await act(async () => {
      for (const listener of Array.from(listeners)) listener();
    });
    expect(await reread).toMatchObject({ projectId: "p1", threadId: "t1", path: "src/app.ts" });
    await node.answerTo("projects.read-file", {
      path: "src/app.ts",
      sizeBytes: 26,
      data: encode("export const port = 9090;\n"),
      truncated: false,
    });
    await expect.element(panel.getByText("9090")).toBeVisible();
    await expect.element(panel.getByText("8080")).not.toBeInTheDocument();
  });
});

describe("the file explorer's context menu (D1642)", () => {
  async function explorer(composer: ChatServices["composer"]) {
    const node = fakeNode();
    const toasts: { title: string; description?: string }[] = [];
    const chat = {
      ...services(node, catalog),
      composer,
      toasts: { show: (toast: { title: string; description?: string }) => toasts.push(toast) },
    } as unknown as ChatServices;
    await mount(
      <FilesPanel onOpenFile={() => undefined} projectId="p1" target={target} threadId="t1" />,
      chat,
    );
    await node.answerTo("projects.list-entries", {
      entries: [
        { path: "src", kind: "directory" },
        { path: "README.md", kind: "file" },
      ],
    });
    await node.answerTo("editors.list", {
      editors: [
        { id: "vscode", label: "VS Code" },
        { id: "file-manager", label: "Files" },
      ],
    });
    return { node, toasts };
  }
  /** A right-click on a row: the tree's rows are in its shadow root, the event is composed. */
  const rightClick = (name: string) =>
    act(() => {
      page
        .getByRole("treeitem", { name })
        .element()
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 2,
            clientX: 40,
            clientY: 80,
          }),
        );
    });

  it("opens a file with the node's editors and adds its mention to the chat", async () => {
    const inserted: { text: string; at: string | undefined }[] = [];
    const composer = {
      current: {
        insert: (text: string, options?: { at?: "cursor" | "end" }) =>
          inserted.push({ text, at: options?.at }) > 0,
      },
    } as unknown as ChatServices["composer"];
    const { node } = await explorer(composer);
    await expect.element(page.getByRole("treeitem", { name: "README.md" })).toBeInTheDocument();
    rightClick("README.md");
    await page.getByRole("menuitem", { name: "Open with" }).click();
    await page.getByRole("menuitem", { name: "VS Code" }).click();
    rightClick("README.md");
    await page.getByRole("menuitem", { name: "Open", exact: true }).click();
    rightClick("README.md");
    await page.getByRole("menuitem", { name: "Add to chat" }).click();
    expect(
      node.calls.filter((call) => call.method === "editors.open").map((call) => call.params),
    ).toEqual([
      { projectId: "p1", threadId: "t1", path: "README.md", editor: "vscode" },
      { projectId: "p1", threadId: "t1", path: "README.md", editor: "file-manager" },
    ]);
    expect(inserted).toEqual([{ text: "[README.md](README.md) ", at: "end" }]);
    localStorage.removeItem("jhin.lastEditor");
  });

  it("offers a folder no editor, and says why a mention cannot go to the chat", async () => {
    const { toasts } = await explorer({ current: undefined });
    await expect.element(page.getByRole("treeitem", { name: "src" })).toBeInTheDocument();
    rightClick("src");
    await expect.element(page.getByRole("menuitem", { name: "Copy mention" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Open with" }).elements()).toHaveLength(0);
    await page.getByRole("menuitem", { name: "Add to chat" }).click();
    expect(toasts).toEqual([
      {
        type: "error",
        title: "Unable to add to chat",
        description: "Open a chat for this project and try again.",
      },
    ]);
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

  it("drops a late answer for another thread's agent", async () => {
    const node = fakeNode();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    function Agent(props: { agentId: string }) {
      const skills = useAgentSkills(
        { call: node.call as ChatServices["threads"]["call"] },
        target,
        "p1",
        props.agentId,
        "turn",
      );
      return <p>skills: {skills.map((skill) => skill.name).join(",")}</p>;
    }
    await act(async () => root.render(<Agent agentId="a" />));
    await act(async () => root.render(<Agent agentId="b" />));
    expect(node.calls.map((call) => call.params["agentId"])).toEqual(["a", "b"]);
    // b answers first; a's late answer, for a view that moved on, is dropped.
    await node.answerAt(1, { commands: [], skills: [{ name: "from-b", path: "/b" }] });
    await expect.element(page.getByText("skills: from-b")).toBeVisible();
    await node.answerAt(0, { commands: [], skills: [{ name: "from-a", path: "/a" }] });
    await expect.element(page.getByText("skills: from-b")).toBeVisible();
    expect(node.calls).toHaveLength(2);
  });
});
