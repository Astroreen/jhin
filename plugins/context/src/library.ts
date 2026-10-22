import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { agentKnowledgeDir } from "@jhin/agent-api";

import {
  decisionRange,
  findHeading,
  markedMaturity,
  maturityRank,
  parsePage,
  type Maturity,
  type Page,
} from "./markdown.ts";

/** How a project arranges its library; the `jhin.context` config section. */
export interface LibrarySettings {
  readonly trailhead: string;
  readonly map: string;
  readonly library: readonly string[];
  readonly lore: string;
  /** Path prefix → level, for pages without front matter (`docs/lore/` → `insight`). */
  readonly maturity: Readonly<Record<string, Maturity>>;
  readonly skill: {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly route: string;
    readonly dirs: readonly string[];
  };
}

export type ContextErrorCode =
  | "PATH_INVALID"
  | "PAGE_NOT_FOUND"
  | "HEADING_NOT_FOUND"
  | "PROJECT_NOT_FOUND";

export class ContextError extends Error {
  readonly code: ContextErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ContextErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ContextError";
    this.code = code;
    this.details = details;
  }
}

export interface Section {
  /** `docs/plans/terminal.md#deferred`, or the path alone for a whole page. */
  readonly address: string;
  readonly path: string;
  readonly heading: string | undefined;
  readonly anchor: string | undefined;
  readonly maturity: Maturity | undefined;
  readonly content: string;
}

interface Broken {
  readonly from: string;
  readonly line: number;
  readonly kind: "link" | "mention";
  readonly target: string;
  readonly reason: "missing" | "anchor";
}

export interface Reachability {
  readonly trailhead: string;
  /** Every page reached, with its hops from the trailhead and the page that first routed to it. */
  readonly reached: readonly { path: string; depth: number; via: string | undefined }[];
  /** Pages of the library no route from the trailhead reaches. */
  readonly unreachable: readonly string[];
  /** Routes that must lead to a page and do not. */
  readonly broken: readonly Broken[];
  /** Mentions of pages without a section that lead nowhere: a page to be written, another repository's file, or a route to fix. */
  readonly unresolved: readonly Omit<Broken, "reason">[];
}

export interface Story {
  readonly name: string;
  readonly title: string;
  readonly lesson: string | undefined;
  readonly address: string;
  readonly scope: "project" | "agent";
}

/** `- **moonbase** (`docs/lore/doghouse-moonbase.md`): the lesson`, as the skill and the brief list stories. */
export const storyLine = (entry: Story): string =>
  `- **${entry.name}** (\`${entry.address}\`)${entry.lesson === undefined ? "" : `: ${entry.lesson}`}`;

const SKIP_DIRS = new Set(["node_modules", "dist"]);
const toPosix = (path: string) => path.split(Path.sep).join("/");

/** The `path#heading` form; a heading given separately wins. */
export function splitAddress(address: string): { path: string; heading: string | undefined } {
  const hash = address.indexOf("#");
  return hash < 0
    ? { path: address, heading: undefined }
    : { path: address.slice(0, hash), heading: address.slice(hash + 1) || undefined };
}

export function createLibrary(root: string, settings: LibrarySettings) {
  const pages = new Map<string, { version: string; page: Page }>();

  /** `path` as a project-relative POSIX path, refusing anything outside the project. */
  let realRoot: string;
  try {
    realRoot = Fs.realpathSync(root);
  } catch {
    // A project whose directory is gone (a stale `projects.list` entry).
    throw new ContextError("PROJECT_NOT_FOUND", `The project directory ${root} does not exist`, {
      root,
    });
  }
  const outside = (inside: string) =>
    inside === ".." || inside.startsWith(`..${Path.sep}`) || Path.isAbsolute(inside);

  /**
   * `path` as a project-relative POSIX path, refusing anything outside the
   * project, also through a symlink (D662).
   */
  const relative = (path: string): string => {
    const absolute = Path.resolve(root, path);
    const inside = Path.relative(root, absolute);
    // The nearest part of the path that exists, resolved: a page, or the
    // directory a skill is about to be written into.
    let existing = absolute;
    let real: string | undefined;
    for (;;) {
      try {
        real = Fs.realpathSync(existing);
        break;
      } catch {
        const parent = Path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    if (outside(inside) || (real !== undefined && outside(Path.relative(realRoot, real)))) {
      throw new ContextError("PATH_INVALID", `${path} is outside the project`, { path });
    }
    return toPosix(inside);
  };

  const exists = (path: string) => Fs.existsSync(Path.join(root, path));
  const isDir = (path: string) =>
    Fs.statSync(Path.join(root, path), { throwIfNoEntry: false })?.isDirectory() === true;

  const load = (path: string): Page => {
    // Only Markdown is a page: `.env` and other files stay out of reach.
    if (!path.endsWith(".md")) {
      throw new ContextError("PATH_INVALID", `${path} is not a Markdown page`, { path });
    }
    const file = Path.join(root, relative(path));
    const stat = Fs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) {
      // A deleted or renamed page leaves the cache too.
      pages.delete(path);
      throw new ContextError("PAGE_NOT_FOUND", `No page ${path} in the project`, { path });
    }
    // ctime changes on every write and cannot be set back, unlike mtime.
    const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = pages.get(path);
    if (cached !== undefined && cached.version === version) return cached.page;
    const page = parsePage(Fs.readFileSync(file, "utf8"));
    pages.set(path, { version, page });
    return page;
  };

  /** Front matter first, then the longest configured prefix (D665). */
  const maturityOf = (path: string, page: Page, heading: Parameters<typeof markedMaturity>[1]) => {
    const marked = markedMaturity(page, heading);
    if (marked !== undefined) return marked;
    const prefix = Object.keys(settings.maturity)
      .filter(
        (candidate) =>
          path === candidate ||
          path.startsWith(candidate.endsWith("/") ? candidate : `${candidate}/`),
      )
      .toSorted((a, b) => b.length - a.length)[0];
    return prefix === undefined ? undefined : settings.maturity[prefix];
  };

  const read = (address: string, explicitHeading?: string): Section => {
    const split = splitAddress(address);
    const path = relative(split.path);
    const wanted = (explicitHeading ?? split.heading)?.replace(/^#/, "") || undefined;
    const page = load(path);
    if (wanted === undefined) {
      return {
        address: path,
        path,
        heading: undefined,
        anchor: undefined,
        maturity: maturityOf(path, page, undefined),
        content: page.body,
      };
    }
    const heading = findHeading(page, wanted);
    // `#D11` and `#d11` name the same decision.
    const range =
      heading ?? (/^D\d+$/i.test(wanted) ? decisionRange(page, wanted.toUpperCase()) : undefined);
    if (range === undefined) {
      throw new ContextError("HEADING_NOT_FOUND", `No heading ${wanted} in ${path}`, {
        path,
        heading: wanted,
        headings: page.headings.map((candidate) => candidate.anchor),
      });
    }
    const anchor = heading?.anchor ?? wanted.toUpperCase();
    // A decision takes the maturity of the section it is written in.
    const enclosing =
      heading ??
      page.headings.findLast(
        (candidate) => candidate.line <= range.line && candidate.end > range.line,
      );
    return {
      address: `${path}#${anchor}`,
      path,
      heading: heading?.text ?? anchor,
      anchor,
      maturity: maturityOf(path, page, enclosing),
      content: page.lines.slice(range.line, range.end).join("\n").trimEnd(),
    };
  };

  const headings = (path: string) =>
    load(relative(path)).headings.map(({ depth, text, anchor }) => ({ depth, text, anchor }));

  /** Every Markdown page under the library directories, plus the trailhead and the map. */
  const libraryPages = (): string[] => {
    const found = new Set<string>();
    const walk = (dir: string) => {
      const entries = Fs.readdirSync(Path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) walk(path);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          found.add(path);
        }
      }
    };
    for (const dir of settings.library) {
      const path = relative(dir);
      if (isDir(path)) walk(path === "" ? "" : path);
      else if (exists(path)) found.add(path);
    }
    for (const page of [settings.trailhead, settings.map]) {
      if (exists(page)) found.add(relative(page));
    }
    return [...found].toSorted();
  };

  /**
   * Where a route from `from` leads: a link resolves against the page's
   * directory; a mention also against the project root. A directory leads to
   * its `README.md`.
   */
  const resolveRoute = (from: string, route: Page["routes"][number]): string | undefined => {
    if (route.target === "") return from;
    // `/docs/map.md` is relative to the project root, as GitHub reads it.
    const rooted = route.target.startsWith("/");
    const target = rooted ? route.target.replace(/^\/+/, "") : route.target;
    const bases = rooted
      ? [""]
      : route.kind === "link"
        ? [Path.posix.dirname(from)]
        : [Path.posix.dirname(from), ""];
    for (const base of bases) {
      const candidate = Path.posix.normalize(Path.posix.join(base, target));
      if (candidate === ".." || candidate.startsWith("../")) continue;
      const path = candidate.replace(/\/$/, "");
      if (!exists(path)) continue;
      try {
        relative(path);
      } catch {
        // A symlink out of the project leads nowhere a reader may go.
        continue;
      }
      const stat = Fs.statSync(Path.join(root, path), { throwIfNoEntry: false });
      // A directory named `x.md`, a socket or a dangling entry is no page.
      if (stat !== undefined && !stat.isDirectory() && !stat.isFile()) continue;
      if (isDir(path)) {
        const readme = `${path === "." ? "" : `${path}/`}README.md`;
        return exists(readme) ? readme : path;
      }
      return path;
    }
    return undefined;
  };

  const hasAnchor = (path: string, fragment: string): boolean => {
    const page = load(path);
    return (
      page.headings.some((heading) => heading.anchor === fragment) ||
      page.decisions.includes(fragment.toUpperCase())
    );
  };

  /** Breadth-first from the trailhead over links and mentions (D664). */
  const reach = (): Reachability => {
    const trailhead = relative(settings.trailhead);
    if (!exists(trailhead)) {
      throw new ContextError("PAGE_NOT_FOUND", `No trailhead ${trailhead} in the project`, {
        path: trailhead,
      });
    }
    const reached = new Map<string, { depth: number; via: string | undefined }>([
      [trailhead, { depth: 0, via: undefined }],
    ]);
    const broken: Broken[] = [];
    const unresolved: Omit<Broken, "reason">[] = [];
    const queue = [trailhead];
    while (queue.length > 0) {
      const from = queue.shift()!;
      const depth = reached.get(from)!.depth;
      for (const route of load(from).routes) {
        const target = resolveRoute(from, route);
        if (target === undefined) {
          const found = { from, line: route.line, kind: route.kind, target: route.target };
          // A link, or a mention of a section (`docs/map.md#shape`), is an
          // address: it must lead somewhere. A plain mention may name a page
          // still to be written, or a file of another repository.
          if (
            route.kind === "link" ||
            (route.fragment !== undefined && route.target.endsWith(".md"))
          ) {
            broken.push({ ...found, reason: "missing" });
          } else if (route.target.endsWith(".md")) {
            unresolved.push(found);
          }
          continue;
        }
        // A directory without a README (even one named `x.md`) is reached, not read.
        if (!target.endsWith(".md") || isDir(target)) continue;
        if (route.fragment !== undefined && !hasAnchor(target, route.fragment)) {
          broken.push({
            from,
            line: route.line,
            kind: route.kind,
            target: `${route.target}#${route.fragment}`,
            reason: "anchor",
          });
        }
        if (!reached.has(target)) {
          reached.set(target, { depth: depth + 1, via: from });
          queue.push(target);
        }
      }
    }
    // A full walk is the moment to forget pages deleted or renamed since.
    for (const path of pages.keys()) if (!exists(path)) pages.delete(path);
    return {
      trailhead,
      reached: [...reached].map(([path, { depth, via }]) => ({ path, depth, via })),
      unreachable: libraryPages().filter((path) => !reached.has(path)),
      broken,
      unresolved,
    };
  };

  /** Lore directories: the project's, then the agent's under its inherited knowledge (A1). */
  const loreDirs = (agent: string | undefined) => [
    { dir: relative(settings.lore), scope: "project" as const },
    ...(agent === undefined
      ? []
      : [{ dir: relative(`${agentKnowledgeDir(agent)}/lore`), scope: "agent" as const }]),
  ];

  const stories = (agent?: string): Story[] => {
    const all: Story[] = [];
    for (const { dir, scope } of loreDirs(agent)) {
      if (!isDir(dir)) continue;
      // The index (README.md) names stories and their lessons: a row or item linking a story file.
      const index = new Map<string, { name: string; lesson: string | undefined }>();
      const readme = `${dir}/README.md`;
      let indexPage: Page | undefined;
      try {
        indexPage = exists(readme) ? load(readme) : undefined;
      } catch (error) {
        // A bad index (a symlink out of the project) leaves names to the stories themselves.
        if (!(error instanceof ContextError)) throw error;
      }
      if (indexPage !== undefined) {
        for (const line of indexPage.lines) {
          // Every story a row or item links shares its lesson.
          const links = [...line.matchAll(/\[([^\]]+)\]\(([^)#\s]+\.md)\)/g)];
          if (links.length === 0) continue;
          const last = links.at(-1)!;
          // The lesson is what follows the last link: `| [a](a.md) | lesson |`, `- [a](a.md): lesson`.
          // In a table the lesson is the next cell, not the rest of the row.
          const after = line.slice(last.index + last[0].length);
          const cell = line.trimStart().startsWith("|") ? (after.split("|")[1] ?? "") : after;
          const rest = cell
            .replace(/^[\s|*-]+|[\s|]+$/g, "")
            .replace(/^[—:–-]\s*/, "")
            .trim();
          for (const link of links) {
            index.set(Path.posix.normalize(`${dir}/${link[2]!}`), {
              name: link[1]!,
              lesson: rest === "" ? undefined : rest,
            });
          }
        }
      }
      const files = Fs.readdirSync(Path.join(root, dir), { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md",
        )
        .map((entry) => entry.name)
        .toSorted();
      for (const name of files) {
        const path = `${dir}/${name}`;
        let page: Page;
        try {
          page = load(path);
        } catch (error) {
          // One bad entry (a symlink out of the project) does not hide the rest.
          if (error instanceof ContextError) continue;
          throw error;
        }
        const title = page.headings.find((heading) => heading.depth === 1)?.text ?? name;
        const named = index.get(path);
        all.push({
          name: named?.name ?? page.frontMatter.name ?? name.replace(/\.md$/, ""),
          title,
          lesson: named?.lesson ?? page.frontMatter.lesson,
          address: path,
          scope,
        });
      }
    }
    return all;
  };

  const story = (
    name: string,
    agent?: string,
  ): Story & { content: string; maturity: Maturity | undefined } => {
    const wanted = name.toLowerCase();
    const found = stories(agent).find(
      (candidate) =>
        candidate.name.toLowerCase() === wanted ||
        candidate.title.toLowerCase() === wanted ||
        candidate.address === name ||
        Path.posix.basename(candidate.address, ".md") === wanted,
    );
    if (found === undefined) {
      throw new ContextError("PAGE_NOT_FOUND", `No story ${name} in the lore`, { name });
    }
    const section = read(found.address);
    return { ...found, content: section.content, maturity: section.maturity };
  };

  /** The router skill, generated from the trailhead's route section, the map and the lore (D668). */
  const skill = () => {
    const map = relative(settings.map);
    const mapPage = exists(map) ? load(map) : undefined;
    const project = Path.basename(root);
    const name =
      settings.skill.name ??
      `${
        project
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "project"
      }-map`;
    const description =
      settings.skill.description ??
      `Before you add anything to ${project}, open this — it probably already has most of it, and this shows where. Also the way in to its decisions, vocabulary and the lore of how agents go wrong here.`;
    const trailhead = relative(settings.trailhead);
    let route: Section | undefined;
    try {
      route = read(trailhead, settings.skill.route);
    } catch (error) {
      if (!(error instanceof ContextError)) throw error;
    }
    const sections = (mapPage?.headings ?? []).filter((heading) => heading.depth === 2);
    const lore = stories();
    const body = [
      `# ${name}`,
      "",
      `Generated from \`${map}\` by \`jhin context.skill.install\`; regenerate it instead of editing it.`,
      ...(route === undefined
        ? []
        : [
            "",
            `## ${route.heading}`,
            "",
            `From \`${route.address}\`:`,
            "",
            // The section without its heading and the blank lines under it, as written.
            ...route.content.replace(/^[^\n]*\n(?:[ \t]*\n)*/, "").split("\n"),
          ]),
      ...(sections.length === 0
        ? []
        : [
            "",
            "## The map",
            "",
            `Read one section, not the whole page: \`jhin context.read --path ${map}#<section>\`.`,
            "",
            ...sections.map((heading) => `- \`${map}#${heading.anchor}\` — ${heading.text}`),
            "",
            "Added a page? Give it a route and check with `jhin context.map`: it lists pages the trailhead does not reach and routes that lead nowhere.",
          ]),
      ...(lore.length === 0
        ? []
        : [
            "",
            "## Lore",
            "",
            "In review a name is enough. Read the story with `jhin lore.get --name <name>`.",
            "",
            ...lore.map(storyLine),
          ]),
    ]
      .join("\n")
      .trimEnd();
    // JSON strings are valid YAML scalars, whatever the description says.
    const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
    return { name, description, content };
  };

  /**
   * Every target is checked before anything is written, and every file is
   * written beside its target before any is renamed into place. A reader
   * sees each target's old skill or its new one, never half of it. A rename
   * that fails (a directory in the way) leaves the targets renamed before it
   * installed and the rest unchanged, and the error says which.
   */
  const install = (generated: ReturnType<typeof skill>) => {
    const paths = settings.skill.dirs.map((dir) => relative(`${dir}/${generated.name}/SKILL.md`));
    const written: string[] = [];
    try {
      for (const path of paths) {
        Fs.mkdirSync(Path.dirname(Path.join(root, path)), { recursive: true });
        // Check again now the directories exist; never follow a link.
        relative(path);
        // Unique per call, so two installs at once never collide on it.
        const temporary = `${path}.${Crypto.randomUUID()}.tmp`;
        const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = Fs.constants;
        const fd = Fs.openSync(
          Path.join(root, temporary),
          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
        );
        written.push(temporary);
        try {
          Fs.writeFileSync(fd, generated.content);
        } finally {
          Fs.closeSync(fd);
        }
      }
    } catch (error) {
      for (const temporary of written) Fs.rmSync(Path.join(root, temporary), { force: true });
      throw error;
    }
    // A rename replaces a link at the target instead of following it.
    paths.forEach((path, index) => {
      try {
        Fs.renameSync(Path.join(root, written[index]!), Path.join(root, path));
      } catch (error) {
        for (const temporary of written.slice(index)) {
          Fs.rmSync(Path.join(root, temporary), { force: true });
        }
        throw new ContextError("PATH_INVALID", `Could not install the skill at ${path}`, {
          path,
          installed: paths.slice(0, index),
          cause: String(error),
        });
      }
    });
    return paths;
  };

  return { root, read, headings, reach, stories, story, skill, install, maturityRank };
}

export type Library = ReturnType<typeof createLibrary>;
