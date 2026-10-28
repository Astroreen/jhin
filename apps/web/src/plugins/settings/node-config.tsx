import {
  coversSection,
  NODE_CONFIG_CHANGED,
  type MeshMember,
  type NodeConfigChanged,
  type NodeConnection,
} from "@jhin/client-api";
import {
  configChange,
  configEdits,
  readConfigSections,
  sendConfigChange,
  type ConfigChange,
  type ConfigRead,
} from "@jhin/host-api";
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Spinner,
  UI_SETTINGS_CAPABILITY,
  type SettingsPages,
} from "@jhin/ui";
import { BracesIcon, ClockIcon, ListIcon, SaveIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

import {
  equal,
  getAt,
  hasUnparsed,
  redact,
  sectionForm,
  setAt,
  validate,
  type JsonSchema,
} from "../../lib/config-form.ts";
import { useExternal } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { SettingsEmpty, SettingsRow, SettingsSection } from "../../lib/settings-layout.tsx";
import {
  Fields,
  SectionJson,
  type FieldInheritance,
  type FieldsContext,
} from "./config-fields.tsx";
import { useSettingsServices } from "./index.tsx";
import {
  PROJECT_SETTINGS_KEY,
  ProjectScopeSentence,
  inheritanceLayers,
  overridesOf,
  projectEntrySchema,
  projectFormSchema,
  projectKeys,
  t3FileFields,
  type ScopeProject,
} from "./project-scope.tsx";

interface Outcome {
  readonly node: string;
  readonly status: "applied" | "conflict" | "queued" | "failed";
  readonly error?: string;
}

interface Pending {
  readonly id: string;
  readonly node: string;
  readonly section: string;
  readonly queuedAt: number;
}

const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The settings section this page is, and the prefix of its outline's entries (D1623). */
const PAGE = "node-config";
/** The element of a config section on the page; the route's anchor names the section (D1628). */
const domId = (section: string) => `${PAGE}-${section}`;
/** Keys that scroll the page: pressed by the user, they end a jump's pin (D1623). */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/** How far outside the viewport a section starts rendering (D1625). */
const NEAR_MARGIN = "600px 0px";

export type ConfigLayer = ConfigChange["layer"];

/** How the page names each file. */
const LAYER_TITLES: Readonly<Record<ConfigLayer, string>> = {
  node: "Node file",
  project: "Project file",
};

/** A section as read, with one file's part being edited: the edit always belongs to it. */
export interface Loaded {
  readonly section: string;
  /** The file being edited. */
  readonly layer: ConfigLayer;
  readonly read: ConfigRead;
  /** The file's part as read, to tell whether it was edited and what changed. */
  readonly original: unknown;
  /** The file's part as edited; text that is no value yet stays `Unparsed`. */
  readonly value: unknown;
  /** The file changed on the node while it was edited; the edits sit on top (D484). */
  readonly rebased?: boolean;
}

const loadedFrom = (section: string, layer: ConfigLayer, read: ConfigRead): Loaded => ({
  section,
  layer,
  read,
  original: read.layers[layer] ?? {},
  value: read.layers[layer] ?? {},
});

/**
 * The editor once the node says the section changed underneath it (D484):
 * without edits, the new file; with edits, each edited path set again on top
 * of the new file, and `rebased` says so.
 */
export function rebase(current: Loaded, next: ConfigRead): Loaded {
  const original = next.layers[current.layer] ?? {};
  // The file as already known (the echo of this page's own save): nothing to say.
  if (equal(original, current.original)) return { ...current, read: next };
  const edits = configEdits(current.original, current.value);
  if (edits.length === 0)
    return { ...current, read: next, original, value: original, rebased: false };
  let value: unknown = original;
  for (const edit of edits) {
    value = setAt(value, edit.path, Object.hasOwn(edit, "value") ? edit.value : undefined) ?? {};
  }
  return { ...current, read: next, original, value, rebased: true };
}

/**
 * The editor once a save of `sent` to `section` is read back as `next`: the
 * file as it is now, and what was changed while saving kept as an edit of it.
 */
export function readBack(
  current: Loaded | undefined,
  section: string,
  sent: unknown,
  next: ConfigRead,
): Loaded | undefined {
  if (current?.section !== section) return current;
  const original = next.layers[current.layer] ?? {};
  return equal(current.value, sent)
    ? { ...current, read: next, original, value: original, rebased: false }
    : { ...current, read: next, original, rebased: false };
}

/**
 * The errors of a section as edited, by dotted path: what the schema refuses
 * as typed, and what the node reported for values not changed since (D84).
 */
export function errorsOf(schema: unknown, loaded: Loaded): Map<string, string[]> {
  const errors = new Map<string, string[]>();
  const add = (path: string, message: string) =>
    errors.set(path, [...(errors.get(path) ?? []), message]);
  for (const issue of validate(schema, loaded.value)) add(issue.path, issue.message);
  for (const issue of loaded.read.issues ?? []) {
    const path = issue.path === "" ? [] : issue.path.split(".");
    if (equal(getAt(loaded.value, path), getAt(loaded.original, path))) {
      add(issue.path, issue.message);
    }
  }
  return errors;
}

/** The sections of a node's schema with their titles, in the order the picker lists them. */
function byTitle(schemas: Readonly<Record<string, JsonSchema>>) {
  return Object.keys(schemas)
    .map((name) => ({ name, title: sectionForm(name, schemas[name]).title }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

/** Every section as the node has it, by name, with one file's part being edited. */
export type LoadedSections = Readonly<Record<string, Loaded>>;

/**
 * Every section of `names` as the node has it (D1624), each landing as its
 * answer does, with the `layer` file's part being edited. Answers for another
 * client or another list of sections are dropped; changing the file keeps
 * the reads and starts each section's edit afresh from them.
 */
export function useLoadedSections(
  client: Pick<NodeConnection["client"], "call">,
  names: readonly string[] | undefined,
  layer: ConfigLayer = "node",
) {
  const [loaded, setLoaded] = useState<LoadedSections>({});
  const layerNow = useRef(layer);
  layerNow.current = layer;
  const key = names?.join("\n");
  useEffect(() => {
    if (names === undefined) return;
    let current = true;
    setLoaded({});
    void readConfigSections(
      (method, params) => client.call(method, params),
      names,
      (section, read) => {
        if (!current) return;
        setLoaded((before) => ({
          ...before,
          [section]: loadedFrom(section, layerNow.current, read),
        }));
      },
    );
    return () => {
      current = false;
    };
  }, [client, key]);
  useEffect(() => {
    setLoaded((before) =>
      Object.values(before).every((item) => item.layer === layer)
        ? before
        : Object.fromEntries(
            Object.entries(before).map(([section, item]) => [
              section,
              item.layer === layer ? item : loadedFrom(section, layer, item.read),
            ]),
          ),
    );
  }, [layer]);
  return [loaded, setLoaded] as const;
}

/** Whether a section holds changes not saved yet. */
const isEdited = (loaded: Loaded | undefined) =>
  loaded !== undefined && !equal(loaded.value, loaded.original);

/** How a confirm names the sections that would lose their edits (D1626). */
export function discardQuestion(titles: readonly string[]): { title: string; description: string } {
  return titles.length === 1
    ? { title: `Discard the changes to ${titles[0]}?`, description: "They were not saved." }
    : {
        title: `Discard the changes to ${titles.length} sections?`,
        description: `Not saved: ${titles.join(", ")}.`,
      };
}

/**
 * A node's config, every section on one page (D18–D20, D80, D1622): a form
 * generated from each section's schema, or its file part as JSON, and the
 * nodes of the mesh to apply a change to — the ones not reachable now get it
 * when they return (D50).
 */
export function NodeConfigSection() {
  const { connections, dialogs } = useSettingsServices();
  const nodes = useExternal(connections, connections.list).filter((node) => node.state === "open");
  const [nodeId, setNodeId] = useState<string | undefined>();
  const node = nodes.find((candidate) => candidate.id === nodeId) ?? nodes[0];
  /** The titles of the sections holding changes not saved yet. */
  const edited = useRef<readonly string[]>([]);
  if (node === undefined) {
    return (
      <SettingsSection title="Node config">
        <SettingsEmpty>Connect a node to see its config.</SettingsEmpty>
      </SettingsSection>
    );
  }
  return (
    <>
      {nodes.length > 1 ? (
        <SettingsSection title="Node">
          <SettingsRow
            control={
              <Select
                onValueChange={(value) => {
                  const next = String(value);
                  if (next === node.id) return;
                  // Another node's config, once unsaved edits are given up on purpose.
                  void (async () => {
                    if (
                      edited.current.length > 0 &&
                      dialogs !== undefined &&
                      !(await dialogs.confirm({
                        ...discardQuestion(edited.current),
                        confirmLabel: "Discard",
                        variant: "destructive",
                      }))
                    ) {
                      return;
                    }
                    edited.current = [];
                    setNodeId(next);
                  })();
                }}
                value={node.id}
              >
                <SelectTrigger aria-label="Node" className="w-full sm:w-56" size="sm">
                  <SelectValue>{node.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {nodes.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
            description="Whose config files to read and change."
            title="Node"
          />
        </SettingsSection>
      ) : null}
      <ConfigPage
        connection={node}
        key={node.id}
        onEdited={(titles) => {
          edited.current = titles;
        }}
      />
    </>
  );
}

/** What every section of the page shares: the node, the file and the scopes (D1622). */
interface PageScope {
  readonly connection: NodeConnection;
  readonly layer: ConfigLayer;
  /** A project of the node, chosen in T3's project scope (D1463). */
  readonly scoped: string | undefined;
  readonly projects: readonly ScopeProject[];
  readonly members: readonly MeshMember[];
  /** The nodes a save goes to (D20). */
  readonly targets: readonly string[];
  /** Sections being saved: their read-back is newer than a change heard meanwhile. */
  readonly saving: MutableRefObject<Set<string>>;
  /** Grows with every save of a section: a read started before one is older than its read-back. */
  readonly reads: MutableRefObject<Map<string, number>>;
  readonly setPending: (pending: readonly Pending[]) => void;
}

function ConfigPage({
  connection,
  onEdited,
}: {
  connection: NodeConnection;
  /** The titles of the sections holding changes not saved yet, each time they change. */
  onEdited(titles: readonly string[]): void;
}) {
  const { context: plugin, mesh, toasts, dialogs } = useSettingsServices();
  const client = connection.client;
  const [schemas, setSchemas] = useState<Readonly<Record<string, JsonSchema>> | undefined>();
  const [layer, setLayer] = useState<ConfigLayer>("node");
  const names = schemas === undefined ? undefined : byTitle(schemas);
  const [loaded, setLoaded] = useLoadedSections(
    client,
    names?.map((item) => item.name),
    layer,
  );
  const [scope, setScope] = useState<readonly string[] | undefined>();
  /** T3's project scope (D1463): a project of this node, or all of them. */
  const [projectScope, setProjectScope] = useState<string | undefined>();
  const [projects, setProjects] = useState<readonly ScopeProject[]>([]);
  const saving = useRef(new Set<string>());
  const reads = useRef(new Map<string, number>());
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const members = useMeshMembers(mesh, connection.id) ?? [];
  const self = members.find((member) => member.self);
  /** Sections rendered for good: near the viewport once, or named by a jump (D1625). */
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  /** The section in view, marked in the outline (D1623). */
  const [inView, setInView] = useState<string | undefined>();
  /** A section to bring into view once it is rendered. */
  const [jumpTo, setJumpTo] = useState<string | undefined>();
  const page = useRef<HTMLDivElement>(null);
  /** The section a jump brought into view: it stays current until the user scrolls themselves. */
  const pinned = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Answers for a client this node no longer has are dropped.
    let current = true;
    void client
      .call<{ properties?: Record<string, JsonSchema> }>("host.config.schema")
      .then((schema) => current && setSchemas(schema.properties ?? {}))
      .catch((error: unknown) => {
        if (!current) return;
        setSchemas({});
        toasts?.show({
          type: "error",
          title: "Cannot read the config",
          description: (error as Error).message,
        });
      });
    void client
      .call<Pending[]>("mesh.config.pending")
      .then((next) => current && setPending(next))
      .catch(() => current && setPending([]));
    // A node without the threads plugin has no projects: the scope stays All projects.
    void client
      .call<{ id: string; name: string; path: string; scratch?: boolean }[]>("projects.list", {})
      .then(
        (next) =>
          current &&
          setProjects(
            next
              .filter((project) => project.scratch !== true)
              .map(({ id, name, path }) => ({ id, name, path })),
          ),
      )
      .catch(() => current && setProjects([]));
    return () => {
      current = false;
    };
  }, [client]);

  // The node says sections changed, whoever changed them: each is read again (D484, D1626).
  const namesKey = names?.map((item) => item.name).join("\n");
  useEffect(() => {
    if (names === undefined) return;
    const subscription = plugin.events.on(NODE_CONFIG_CHANGED, (payload) => {
      const changed = payload as NodeConfigChanged;
      const covered = names
        .map((item) => item.name)
        .filter(
          (section) =>
            !saving.current.has(section) && coversSection(changed, connection.id, section),
        );
      if (covered.length === 0) return;
      const started = new Map(covered.map((section) => [section, reads.current.get(section) ?? 0]));
      void readConfigSections(
        (method, params) => client.call(method, params),
        covered,
        (section, next) => {
          // A save began meanwhile: its read-back is newer than this answer.
          if (started.get(section) !== (reads.current.get(section) ?? 0)) return;
          // Unreadable now: the next change, a save or a reload reads it again.
          if (next.error !== undefined && Object.keys(next.layers).length === 0) return;
          // Rebased onto whatever the editor holds by now, edits made during the read included.
          setLoaded((before) => {
            const latest = before[section];
            return latest === undefined ? before : { ...before, [section]: rebase(latest, next) };
          });
        },
      );
    });
    return () => subscription.dispose();
  }, [client, connection.id, namesKey]);

  const titleOf = (section: string) =>
    names?.find((item) => item.name === section)?.title ?? section;
  const editedItems = (names ?? []).filter((item) => isEdited(loaded[item.name]));
  const editedSections = editedItems.map((item) => item.title);
  const editedKey = editedItems.map((item) => item.name).join("\n");
  useEffect(() => onEdited(editedSections), [editedKey]);
  // Gone (another node chosen, or this one disconnected): nothing of it is unsaved.
  useEffect(() => () => onEdited([]), []);
  // A reload or a closed tab asks the browser's own question (D1626).
  useEffect(() => {
    if (editedSections.length === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editedKey]);

  /** A confirm is open: a second one answers no, so two quick clicks ask once. */
  const confirming = useRef(false);
  /** Whether unsaved edits may go: they are none, or the user gives them up (D1626). */
  const discard = async () => {
    if (editedSections.length === 0) return true;
    if (confirming.current) return false;
    confirming.current = true;
    try {
      const question = discardQuestion(editedSections);
      // Without the dialogs service, the browser's own confirm: edits never go unasked.
      return dialogs === undefined
        ? window.confirm(`${question.title}\n${question.description}`)
        : await dialogs.confirm({ ...question, confirmLabel: "Discard", variant: "destructive" });
    } finally {
      confirming.current = false;
    }
  };
  const discardRef = useRef(discard);
  discardRef.current = discard;

  /** The other file, once unsaved edits are given up on purpose (D477). */
  const chooseLayer = async (next: ConfigLayer) => {
    if (next === layer || !(await discard())) return;
    setLayer(next);
  };
  /** Another project scope, once unsaved edits are given up on purpose (D1626). */
  const chooseProject = async (next: string | undefined) => {
    if (next === projectScope || !(await discard())) return;
    setLoaded((before) =>
      Object.fromEntries(
        Object.entries(before).map(([section, item]) => [
          section,
          isEdited(item) ? { ...item, value: item.original } : item,
        ]),
      ),
    );
    setProjectScope(next);
  };

  // The outline in the settings navigation (D1623, D1629).
  const pages = plugin.services.tryGet<SettingsPages>(UI_SETTINGS_CAPABILITY);
  const select = (id: string) => {
    const section = id.slice(PAGE.length + 1);
    setShown((before) => (before.has(section) ? before : new Set(before).add(section)));
    pinned.current = section;
    setInView(section);
    setJumpTo(section);
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  /** The latest outline: a later `setOutline` replaces it, so a scroll never leaves a gap. */
  const outlined = useRef<{ dispose(): void } | undefined>(undefined);
  useEffect(
    () => () => {
      outlined.current?.dispose();
      outlined.current = undefined;
    },
    [pages, namesKey],
  );
  useEffect(() => {
    if (pages?.setOutline === undefined || names === undefined) return;
    outlined.current = pages.setOutline(PAGE, {
      entries: names.map((item) => ({
        id: `${PAGE}/${item.name}`,
        label: item.title,
        ...(item.title === item.name ? {} : { hint: item.name }),
      })),
      ...(inView === undefined ? {} : { current: `${PAGE}/${inView}` }),
      select: (id) => selectRef.current(id),
      confirmLeave: () => discardRef.current(),
    });
  }, [pages, namesKey, inView]);

  // A jump: once the section is rendered, it comes into view and its heading takes focus.
  useEffect(() => {
    if (jumpTo === undefined) return;
    const element = document.getElementById(domId(jumpTo));
    if (element === null) return;
    element.scrollIntoView({ block: "start" });
    const heading = element.querySelector("h2");
    if (heading !== null) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    setJumpTo(undefined);
  }, [jumpTo, shown]);

  // Which sections are near the viewport (D1625), and which one is in view (D1623).
  useEffect(() => {
    const root = page.current?.closest<HTMLElement>("[data-settings-page-scroll]") ?? null;
    const elements = [
      ...(page.current?.querySelectorAll<HTMLElement>("[data-config-section]") ?? []),
    ];
    if (elements.length === 0) return;
    const near = new IntersectionObserver(
      (entries) => {
        const reached = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset["configSection"] ?? "");
        if (reached.length === 0) return;
        setShown((before) =>
          reached.every((section) => before.has(section))
            ? before
            : new Set([...before, ...reached]),
        );
      },
      { root, rootMargin: NEAR_MARGIN },
    );
    for (const element of elements) near.observe(element);
    let frame: number | undefined;
    const spy = () => {
      frame = undefined;
      // The last sections cannot reach the top: a jump to one keeps it current.
      if (pinned.current !== undefined) return;
      const top = (root?.getBoundingClientRect().top ?? 0) + 96;
      let passed: string | undefined;
      for (const element of elements) {
        if (element.getBoundingClientRect().top > top) break;
        passed = element.dataset["configSection"];
      }
      setInView(passed ?? elements[0]?.dataset["configSection"]);
    };
    const onScroll = () => {
      frame ??= requestAnimationFrame(spy);
    };
    // Only the user's own scrolling ends a jump's pin: a wheel, a touch, a key that scrolls
    // outside a field. Typing, Tab and clicks leave it.
    const unpin = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (!SCROLL_KEYS.has(event.key)) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable=true], [role=combobox]"))
          return;
      }
      pinned.current = undefined;
    };
    // A press on the scroll container itself is its scrollbar.
    const onPointerDown = (event: Event) => {
      if (event.target === root) unpin(event);
    };
    const target: HTMLElement | Window = root ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    target.addEventListener("pointerdown", onPointerDown, { passive: true });
    for (const kind of ["wheel", "touchstart", "keydown"]) {
      target.addEventListener(kind, unpin, { passive: true });
    }
    spy();
    return () => {
      near.disconnect();
      target.removeEventListener("scroll", onScroll);
      target.removeEventListener("pointerdown", onPointerDown);
      for (const kind of ["wheel", "touchstart", "keydown"]) {
        target.removeEventListener(kind, unpin);
      }
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [namesKey]);

  const targets = scope ?? (self === undefined ? [] : [self.nodeId]);
  const scoped =
    projectScope !== undefined && projects.some((project) => project.id === projectScope)
      ? projectScope
      : undefined;
  const shared: PageScope = {
    connection,
    layer,
    scoped,
    projects,
    members,
    targets,
    saving,
    reads,
    setPending,
  };
  const nameOf = (nodeId: string) =>
    members.find((member) => member.nodeId === nodeId)?.name ?? nodeId;

  return (
    <div className="flex flex-col gap-8" ref={page}>
      <SettingsSection title={`Config of ${connection.label}`}>
        {names === undefined ? (
          <SettingsEmpty>
            <Spinner size="sm" tone="muted" />
          </SettingsEmpty>
        ) : names.length === 0 ? (
          <SettingsEmpty>This node shares no config sections.</SettingsEmpty>
        ) : (
          <>
            <SettingsRow
              control={
                <Select
                  onValueChange={(value) => void chooseLayer(value as ConfigLayer)}
                  value={layer}
                >
                  <SelectTrigger aria-label="Config file" className="w-full sm:w-64" size="sm">
                    <SelectValue>{LAYER_TITLES[layer]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="node">{LAYER_TITLES.node}</SelectItem>
                    <SelectItem value="project">{LAYER_TITLES.project}</SelectItem>
                  </SelectPopup>
                </Select>
              }
              description="The node's config.jsonc, or .jhin/config.jsonc of the project the node was started in, which wins over it."
              title="File"
            />
            {projects.length === 0 ? null : (
              <ProjectScopeSentence
                onChange={(next) => void chooseProject(next)}
                projects={projects}
                value={scoped}
              />
            )}
            {members.length > 1 ? (
              <SettingsRow
                description="Every node of the mesh can take the same change; one that is offline gets it when it returns."
                title="Apply to"
              >
                <div
                  aria-label="Apply to nodes"
                  className="mt-2 mb-2 flex flex-wrap gap-x-4 gap-y-2"
                  role="group"
                >
                  {members.map((member) => (
                    <label
                      className="flex cursor-pointer items-center gap-2 text-sm"
                      key={member.nodeId}
                    >
                      <Checkbox
                        checked={targets.includes(member.nodeId)}
                        onCheckedChange={(checked) =>
                          setScope(
                            checked
                              ? [...targets, member.nodeId]
                              : targets.filter((target) => target !== member.nodeId),
                          )
                        }
                      />
                      {member.name}
                      {member.self ? (
                        <span className="text-xs text-muted-foreground">(this node)</span>
                      ) : null}
                      {!member.reachable && !member.self ? (
                        <span className="text-xs text-muted-foreground">offline</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </SettingsRow>
            ) : null}
          </>
        )}
      </SettingsSection>
      {(names ?? []).map((item) => (
        <div data-config-section={item.name} id={domId(item.name)} key={item.name}>
          {shown.has(item.name) ? (
            <ConfigSectionCard
              loaded={loaded[item.name]}
              name={item.name}
              schema={schemas?.[item.name]}
              scope={shared}
              title={item.title}
              update={(change) =>
                setLoaded((before) => {
                  const latest = before[item.name];
                  if (latest === undefined) return before;
                  const next = change(latest);
                  return next === latest ? before : { ...before, [item.name]: next };
                })
              }
            />
          ) : (
            <SectionPlaceholder
              name={item.name}
              onFound={() => select(`${PAGE}/${item.name}`)}
              schema={schemas?.[item.name]}
              title={item.title}
            />
          )}
        </div>
      ))}
      {pending.length === 0 ? null : (
        <SettingsSection icon={<ClockIcon className="size-4" />} title="Waiting for their node">
          {pending.map((change) => (
            <SettingsRow
              description={`Queued ${new Date(change.queuedAt).toLocaleString()}`}
              key={change.id}
              title={`${titleOf(change.section)} → ${nameOf(change.node)}`}
            />
          ))}
        </SettingsSection>
      )}
    </div>
  );
}

/** The title a section shows: its name in mono next to a title that differs (D1622). */
function SectionTitle({ name, title }: { name: string; title: string }) {
  return title === name ? (
    <span className="font-mono">{name}</span>
  ) : (
    <>
      {title}
      <span className="ms-2 font-mono text-xs text-muted-foreground">{name}</span>
    </>
  );
}

/**
 * A section not near the viewport yet (D1625): its height guessed from its
 * fields, and their words kept for the browser's find (`hidden="until-found"`),
 * which renders the section when it matches.
 */
function SectionPlaceholder({
  name,
  title,
  schema,
  onFound,
}: {
  name: string;
  title: string;
  schema: JsonSchema | undefined;
  onFound(): void;
}) {
  const form = sectionForm(name, schema);
  const found = useRef(onFound);
  found.current = onFound;
  const words = useRef<HTMLDivElement>(null);
  // Before the first paint, so the words never flash.
  useLayoutEffect(() => {
    const element = words.current;
    if (element === null) return;
    element.setAttribute("hidden", "until-found");
    const onMatch = () => found.current();
    element.addEventListener("beforematch", onMatch);
    return () => element.removeEventListener("beforematch", onMatch);
  }, []);
  return (
    <section aria-busy="true" aria-label={title} className="space-y-2.5">
      <div className="flex min-h-7 items-start px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center text-sm font-normal text-foreground/70">
          <SectionTitle name={name} title={title} />
        </h2>
      </div>
      <div
        className="rounded-xl border border-border/60 bg-card/40"
        style={{ minHeight: Math.min(160 + form.fields.length * 64, 1200) }}
      >
        <div ref={words}>
          {form.description === undefined ? null : <p>{form.description}</p>}
          {form.fields.map((field) => (
            <p key={field.key}>
              {field.title}
              {field.description === undefined ? null : ` ${field.description}`}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

/** One section of the page: its form or JSON, Save and outcomes, as one section had (D1622). */
function ConfigSectionCard({
  name,
  title,
  schema,
  loaded,
  update,
  scope,
}: {
  name: string;
  title: string;
  schema: JsonSchema | undefined;
  /** Undefined until the node answers for it. */
  loaded: Loaded | undefined;
  update(change: (current: Loaded) => Loaded): void;
  scope: PageScope;
}) {
  const { context: plugin, toasts } = useSettingsServices();
  const { connection, layer, scoped, projects, members, targets } = scope;
  const client = connection.client;
  const [asJson, setAsJson] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  /** The chosen project's `t3.json`, for the settings it backs (D1467); `failed`: not shown. */
  const [t3File, setT3File] = useState<{
    readonly projectId: string;
    readonly file: unknown;
    readonly failed?: boolean;
  }>();
  const self = members.find((member) => member.self);
  // The previous file's outcome is not this one's.
  useEffect(() => setOutcomes([]), [layer]);

  const read = loaded?.read;
  const edited = isEdited(loaded);
  const form = loaded === undefined ? undefined : sectionForm(name, schema, read?.comments);
  const errors = loaded === undefined ? new Map<string, string[]>() : errorsOf(schema, loaded);
  // Only JSON can edit a section without keys, or a file part that is no object.
  const formFits = form !== undefined && form.fields.length > 0 && isObject(loaded?.value);
  const showJson = asJson || !formFits;
  const unknownKeys =
    form === undefined || !isObject(loaded?.value)
      ? []
      : Object.keys(loaded.value).filter((key) => !form.fields.some((field) => field.key === key));

  // The project scope (D1463): a project's entry of the section's `projects` record.
  const entry = projectEntrySchema(schema);
  const backedBy = entry === undefined ? new Map<string, string>() : t3FileFields(entry);
  useEffect(() => {
    if (scoped === undefined || backedBy.size === 0) return;
    let current = true;
    void client
      .call<{ file: unknown; error?: string }>("projects.t3-file.get", { projectId: scoped })
      .then(
        (answer) =>
          current &&
          setT3File({
            projectId: scoped,
            file: answer.file,
            ...(answer.error === undefined ? {} : { failed: true }),
          }),
      )
      .catch(() => current && setT3File({ projectId: scoped, file: null, failed: true }));
    return () => {
      current = false;
    };
  }, [client, scoped, backedBy.size]);

  const other: ConfigLayer = layer === "node" ? "project" : "node";
  const blocked =
    loaded === undefined ||
    // Another file chosen, and not read yet: the edit is still the old file's.
    loaded.layer !== layer ||
    !isObject(loaded.value) ||
    hasUnparsed(loaded.value) ||
    validate(schema, loaded.value).length > 0;

  const save = async () => {
    if (loaded === undefined || blocked || !isObject(loaded.value)) return;
    // The value saved, whatever is changed meanwhile.
    const { value: sent, original, layer: file } = loaded;
    // Only the paths that changed are written, so the rest keeps its comments (D84, D476).
    const change = configChange(file, name, original, sent);
    setBusy(true);
    scope.saving.current.add(name);
    scope.reads.current.set(name, (scope.reads.current.get(name) ?? 0) + 1);
    // The previous save's outcome is not this one's.
    setOutcomes([]);
    try {
      const onlySelf = self === undefined || (targets.length === 1 && targets[0] === self.nodeId);
      if (onlySelf) {
        const node = self?.nodeId ?? connection.label;
        try {
          // Checked for what the node can do before anything is written (D475).
          const result = await sendConfigChange(
            (method, params) => client.call(method, params),
            change,
          );
          setOutcomes([{ node, status: result.applied ? "applied" : "conflict" }]);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "CONFIG_CHANGE_UNSUPPORTED") throw error;
          setOutcomes([{ node, status: "failed", error: (error as Error).message }]);
          return;
        }
      } else {
        const result = await client.call<{ results: Outcome[] }>("mesh.config.patch", {
          nodes: targets,
          ...change,
        });
        setOutcomes(result.results);
        await client
          .call<Pending[]>("mesh.config.pending")
          .then(scope.setPending)
          .catch(() => undefined);
      }
    } catch (error) {
      toasts?.show({
        type: "error",
        title: "Setting not saved",
        description: (error as Error).message,
      });
      return;
    } finally {
      setBusy(false);
      scope.saving.current.delete(name);
    }
    // Other plugins follow what the section means (the node icons, `jhin.host`).
    plugin.events.emit("settings.node-config.saved", {
      connection: connection.id,
      section: name,
    });
    // What the file holds now.
    try {
      const next = await client.call<ConfigRead>("host.config.get", { section: name });
      update((current) => readBack(current, name, sent, next) ?? current);
    } catch (error) {
      toasts?.show({
        type: "warning",
        title: "Saved, but not read back",
        description: (error as Error).message,
      });
    }
  };

  const nameOf = (nodeId: string) =>
    members.find((member) => member.nodeId === nodeId)?.name ?? nodeId;

  const context: FieldsContext | undefined =
    loaded === undefined
      ? undefined
      : {
          value: loaded.value,
          other: { layer: other, value: read?.layers[other] },
          errors,
          root: schema ?? {},
          set: (path, next) =>
            update((current) => ({ ...current, value: setAt(current.value, path, next) ?? {} })),
        };

  const keys = entry === undefined ? [] : projectKeys(entry);
  const entryPath = scoped === undefined ? [] : [PROJECT_SETTINGS_KEY, scoped];
  // The project file wins over the node file (D19), whichever of them is edited.
  const nodeSets = (key: string) => {
    const editedValue = getAt(loaded?.value, [key]);
    const otherFile = getAt(read?.layers[other], [key]);
    return layer === "project" ? (editedValue ?? otherFile) : (otherFile ?? editedValue);
  };
  const t3Value = (key: string) => {
    const field = backedBy.get(key);
    return field === undefined || t3File?.projectId !== scoped
      ? undefined
      : getAt(t3File?.file, [field]);
  };
  // A key without a default of its own falls back to what its project key names (T3's builtIn).
  const nodeDefault = (key: string) =>
    getAt(schema, ["properties", key, "default"]) ?? getAt(entry, ["properties", key, "builtIn"]);
  const nodeFields = new Map(form?.fields.map((field) => [field.key, field]) ?? []);
  const projectSchema =
    entry === undefined || scoped === undefined || schema === undefined
      ? undefined
      : projectFormSchema(
          schema,
          entry,
          // The same layers the popover shows: the node's files as edited, t3.json, the default.
          (key) => nodeSets(key) ?? t3Value(key) ?? nodeDefault(key),
        );
  const projectForm =
    projectSchema === undefined || loaded === undefined
      ? undefined
      : sectionForm(name, projectSchema);
  const prefix = `${entryPath.join(".")}.`;
  const projectContext: FieldsContext | undefined =
    projectSchema === undefined || loaded === undefined || scoped === undefined
      ? undefined
      : {
          value: getAt(loaded.value, entryPath) ?? {},
          other: { layer: other, value: getAt(read?.layers[other], entryPath) },
          errors: new Map(
            [...errors].flatMap(([path, messages]) =>
              path.startsWith(prefix) ? [[path.slice(prefix.length), messages] as const] : [],
            ),
          ),
          root: projectSchema,
          resetTooltip: "Reset to inherited value",
          unsetLabel: "Inherit",
          set: (path, next) =>
            update((current) => {
              let value = setAt(current.value, [...entryPath, ...path], next) ?? {};
              // What is left empty goes, up to the record itself (its default is empty):
              // a project setting reset to Inherit leaves no `{}` behind.
              for (let end = entryPath.length + path.length - 1; end >= 1; end -= 1) {
                const at = [...entryPath, ...path].slice(0, end);
                const left = getAt(value, at);
                if (!isObject(left) || Object.keys(left).length > 0) break;
                value = setAt(value, at, undefined) ?? {};
              }
              return { ...current, value };
            }),
          inheritance: (field): FieldInheritance => {
            const layers = inheritanceLayers({
              field: nodeFields.get(field.key) ?? field,
              nodeLabel: connection.label,
              project: getAt(loaded.value, [...entryPath, field.key]),
              node: nodeSets(field.key),
              // A t3.json that could not be read shows no layer: it may hold a value.
              t3File:
                backedBy.has(field.key) && t3File?.failed !== true
                  ? { value: t3Value(field.key) }
                  : undefined,
              fallback: nodeDefault(field.key),
            });
            const effective = layers.find((item) => item.effective);
            return {
              layers,
              overridden: effective?.key === "project",
              summary:
                effective?.key === "project"
                  ? "Project override"
                  : `Inherited from ${effective?.label ?? "the node"}`,
            };
          },
        };
  /** With All projects chosen, a field says how many projects override it (T3's summary). */
  const allContext: FieldsContext | undefined =
    context === undefined || entry === undefined
      ? context
      : {
          ...context,
          inheritance: (field) => {
            if (!keys.includes(field.key)) return undefined;
            // The node's projects only: an entry of one removed stays in the JSON view.
            const count = overridesOf(
              loaded?.value,
              field.key,
              projects.map((project) => project.id),
            );
            return count === 0
              ? undefined
              : {
                  overridden: false,
                  summary: `${count} project ${count === 1 ? "override" : "overrides"}`,
                };
          },
        };
  const nodeWide = (form?.fields ?? []).filter(
    (field) => field.key !== PROJECT_SETTINGS_KEY && !keys.includes(field.key),
  );

  return (
    <SettingsSection
      headerAction={
        formFits ? (
          <Button
            aria-pressed={asJson}
            onClick={() => setAsJson((current) => !current)}
            size="xs"
            variant="ghost-muted"
          >
            {asJson ? <ListIcon /> : <BracesIcon />}
            {asJson ? "Edit as form" : "Edit as JSON"}
          </Button>
        ) : null
      }
      title={title}
    >
      {loaded === undefined || form === undefined || context === undefined ? (
        <SettingsEmpty>
          <Spinner size="sm" tone="muted" />
        </SettingsEmpty>
      ) : (
        <>
          <div className="space-y-1 px-3 py-3 sm:px-4">
            <p className="font-mono text-xs text-muted-foreground">{name}</p>
            {form.description === undefined ? null : (
              <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
                {form.description}
              </p>
            )}
            {loaded.rebased === true && edited ? (
              <p className="text-xs text-info-foreground" role="status">
                Changed on the node while you edited; your changes are kept on top of it.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground/80">
              {layer === "node"
                ? "Changes go to this section of the node's config.jsonc, keeping its comments; a key left unset takes its default."
                : "Changes go to this section of the project's .jhin/config.jsonc, keeping its comments; a key left unset takes the node file's value or its default."}
            </p>
          </div>
          {read?.error === undefined ? null : (
            <div className="px-3 py-3 sm:px-4">
              <Alert variant="error">
                <AlertDescription>{read.error}</AlertDescription>
              </Alert>
            </div>
          )}
          {showJson ? (
            <>
              <SettingsRow
                description="What the plugins see now: every layer merged, defaults filled in."
                title="Effective value"
              >
                <pre className="mt-2 mb-2 max-h-56 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs">
                  {read?.error ?? pretty(redact(schema, read?.value, schema ?? {}))}
                </pre>
              </SettingsRow>
              <SettingsRow
                description={`This section in ${layer === "node" ? "the node's config.jsonc" : "the project's .jhin/config.jsonc"}.${formFits ? "" : " Its schema has no keys a form can show."}`}
                title={LAYER_TITLES[layer]}
              >
                <SectionJson
                  messages={[...errors.entries()].flatMap(([path, messages]) =>
                    messages.map((message) => (path === "" ? message : `${path}: ${message}`)),
                  )}
                  onChange={(next) => update((current) => ({ ...current, value: next }))}
                  schema={schema ?? {}}
                  label={`${name} in the ${LAYER_TITLES[layer].toLowerCase()}`}
                  value={loaded.value}
                />
              </SettingsRow>
            </>
          ) : scoped !== undefined ? (
            entry === undefined || projectForm === undefined || projectContext === undefined ? (
              <SettingsEmpty>This section has no project settings.</SettingsEmpty>
            ) : (
              <>
                <Fields context={projectContext} fields={projectForm.fields} path={[]} />
                {nodeWide.length === 0 ? null : (
                  <fieldset aria-label="Node-wide settings" disabled>
                    <SettingsRow
                      description="Node-wide setting. Choose All projects to change it."
                      title="Node-wide settings"
                    />
                    <Fields context={{ ...context, disabled: true }} fields={nodeWide} path={[]} />
                  </fieldset>
                )}
              </>
            )
          ) : (
            <>
              <Fields
                context={allContext ?? context}
                fields={
                  entry === undefined
                    ? form.fields
                    : form.fields.filter((field) => field.key !== PROJECT_SETTINGS_KEY)
                }
                path={[]}
              />
              {unknownKeys.length === 0 ? null : (
                <SettingsRow
                  description={`The ${LAYER_TITLES[layer].toLowerCase()} also sets ${unknownKeys.join(", ")}, which the schema does not know. Saving keeps them; edit them as JSON.`}
                  title="Other keys"
                />
              )}
            </>
          )}
          <div className="flex items-center justify-end gap-2 px-3 py-3 sm:px-4">
            {/* Announced when a save ends, for screen readers too. */}
            <div aria-live="polite" className="me-auto" role="status">
              {outcomes.length === 0 ? null : (
                <ul aria-label="Outcome" className="flex flex-wrap gap-x-3 text-xs">
                  {outcomes.map((outcome) => (
                    <li
                      className={
                        outcome.status === "applied"
                          ? "text-success-foreground"
                          : outcome.status === "queued"
                            ? "text-info-foreground"
                            : "text-destructive-foreground"
                      }
                      key={outcome.node}
                    >
                      {nameOf(outcome.node)}: {outcome.status}
                      {outcome.error === undefined ? "" : ` (${outcome.error})`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              disabled={!edited}
              onClick={() => update((current) => ({ ...current, value: current.original }))}
              size="sm"
              variant="ghost"
            >
              Discard
            </Button>
            <Button
              // Without the mesh (or before it answers) the change is this node's alone.
              disabled={busy || !edited || blocked || (self !== undefined && targets.length === 0)}
              onClick={() => void save()}
              size="sm"
            >
              {busy ? <Spinner size="sm" /> : <SaveIcon />}
              Save
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
