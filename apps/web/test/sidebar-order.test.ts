import type { NodeTarget, ProjectRecord, ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import {
  listedThreads,
  projectKey,
  shownThreads,
  sidebarProjects,
} from "../src/lib/sidebar-order.ts";

const thread = (id: string, at: string, extra: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id,
  projectId: "p",
  title: id,
  createdAt: at,
  ...extra,
});

const ids = (threads: readonly ThreadRecord[]) => threads.map((item) => item.id);

describe("the sidebar's threads", () => {
  const listed = listedThreads(
    [
      thread("old", "2026-10-18T09:00:00.000Z"),
      thread("archived", "2026-10-18T12:00:00.000Z", { archivedAt: "2026-10-18T12:30:00.000Z" }),
      thread("other-project", "2026-10-18T12:00:00.000Z", { projectId: "q" }),
      thread("busy", "2026-10-18T08:00:00.000Z", {
        lastTurn: {
          turnId: "u",
          status: "running",
          at: "2026-10-18T11:00:00.000Z",
          agentId: "fake",
        },
      }),
      thread("new", "2026-10-18T10:00:00.000Z"),
    ],
    "p",
  );

  it("lists a project's threads by their latest activity, without archived ones", () => {
    expect(ids(listed)).toEqual(["busy", "new", "old"]);
  });

  it("shows the first few, all on demand, and the open thread wherever it is", () => {
    expect(ids(shownThreads(listed, { query: "", limit: 2, showAll: false }).shown)).toEqual([
      "busy",
      "new",
    ]);
    expect(ids(shownThreads(listed, { query: "", limit: 2, showAll: true }).shown)).toEqual([
      "busy",
      "new",
      "old",
    ]);
    expect(
      ids(shownThreads(listed, { query: "", limit: 2, showAll: false, current: "old" }).shown),
    ).toEqual(["busy", "new", "old"]);
  });

  it("shows every match of a search, whatever the limit", () => {
    const search = shownThreads(listed, { query: " N ", limit: 1, showAll: false });
    expect(ids(search.matching)).toEqual(["new"]);
    expect(ids(search.shown)).toEqual(["new"]);
    expect(ids(shownThreads(listed, { query: "o", limit: 1, showAll: false }).shown)).toEqual([
      "old",
    ]);
  });
});

const project = (id: string, name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id,
  name,
  path: `/work/${name}`,
  scratch: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...extra,
});

const node = (
  target: NodeTarget,
  projects: readonly ProjectRecord[],
  threads: readonly ThreadRecord[] = [],
) => ({ target, catalog: { projects, threads } });

const keys = (projects: readonly { key: string }[]) => projects.map((item) => item.key);

describe("the sidebar's projects (D70)", () => {
  const scratch = project("scratch", "No project", { scratch: true });

  it("lists the projects of every node in one list, the latest activity first, as T3 does", () => {
    const a = node(
      { node: "a" },
      [scratch, project("web", "web"), project("api", "api")],
      [
        thread("old", "2026-10-18T09:00:00.000Z", { projectId: "web" }),
        thread("loose", "2026-10-18T10:00:00.000Z", { projectId: "scratch" }),
      ],
    );
    const b = node(
      { node: "a", remote: "b" },
      [scratch, project("web", "web")],
      [thread("new", "2026-10-18T11:00:00.000Z", { projectId: "web" })],
    );
    expect(keys(sidebarProjects([a, b]))).toEqual([
      "a|b|web",
      "a|scratch",
      "a|web",
      // No threads: when it was created.
      "a|api",
    ]);
  });

  it("keeps projects of the same name on different nodes apart, ties by name then node", () => {
    const listed = sidebarProjects([
      node({ node: "y" }, [project("p", "web")]),
      node({ node: "x" }, [project("p", "web"), project("q", "app")]),
    ]);
    expect(keys(listed)).toEqual(["x|q", "x|p", "y|p"]);
    expect(listed.map((item) => item.node.target.node)).toEqual(["x", "x", "y"]);
  });

  it("shows a scratch project only with threads, or while a thread is drafted in it", () => {
    const a = node({ node: "a" }, [scratch, project("web", "web")]);
    expect(keys(sidebarProjects([a]))).toEqual(["a|web"]);
    expect(keys(sidebarProjects([a], projectKey({ node: "a" }, "scratch")))).toEqual([
      "a|scratch",
      "a|web",
    ]);
    // A draft on another node does not show this node's scratch project.
    expect(keys(sidebarProjects([a], projectKey({ node: "b" }, "scratch")))).toEqual(["a|web"]);
  });

  it("gives each project its listed threads, without archived ones", () => {
    const [web] = sidebarProjects([
      node(
        { node: "a" },
        [project("web", "web")],
        [
          thread("one", "2026-10-18T09:00:00.000Z", { projectId: "web" }),
          thread("gone", "2026-10-18T12:00:00.000Z", {
            projectId: "web",
            archivedAt: "2026-10-18T12:30:00.000Z",
          }),
        ],
      ),
    ]);
    expect(ids(web!.threads)).toEqual(["one"]);
  });
});
