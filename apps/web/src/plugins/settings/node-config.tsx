import {
  coversSection,
  NODE_CONFIG_CHANGED,
  type NodeConfigChanged,
  type NodeConnection,
} from "@jhin/client-api";
import { configChange, configEdits, sendConfigChange, type ConfigChange } from "@jhin/host-api";
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
} from "@jhin/ui";
import { BracesIcon, ClockIcon, ListIcon, SaveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  equal,
  getAt,
  hasUnparsed,
  redact,
  sectionForm,
  setAt,
  validate,
  type ConfigComment,
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

interface ConfigRead {
  readonly value?: unknown;
  readonly error?: string;
  /** Why the effective value is invalid, by dotted path (D84). */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
  readonly layers: { readonly node?: unknown; readonly project?: unknown };
  /** Comments above the section's keys in the config files (D81); older nodes send none. */
  readonly comments?: readonly ConfigComment[];
}

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

/** Which of a node's config files the page edits (D477). */
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
 * The chosen section as the node has it, and its node file part being edited.
 * An answer for a section no longer chosen is dropped, so the edit always
 * belongs to the section it names.
 */
export function useLoadedSection(
  client: Pick<NodeConnection["client"], "call">,
  section: string | undefined,
  layer: ConfigLayer = "node",
) {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  useEffect(() => {
    if (section === undefined) return;
    let current = true;
    setLoaded(undefined);
    void client
      .call<ConfigRead>("host.config.get", { section })
      .then((next) => {
        if (current) setLoaded(loadedFrom(section, layer, next));
      })
      .catch((error: unknown) => {
        if (current) {
          setLoaded(loadedFrom(section, layer, { error: (error as Error).message, layers: {} }));
        }
      });
    return () => {
      current = false;
    };
  }, [client, section, layer]);
  // Until the read of another section or file lands, nothing is shown, so nothing is edited.
  const current = loaded?.section === section && loaded?.layer === layer ? loaded : undefined;
  return [current, setLoaded] as const;
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

/**
 * A node's config, section by section (D18–D20, D80): a form generated from
 * the section's schema, or its node file part as JSON, and the nodes of the
 * mesh to apply the change to — the ones not reachable now get it when they
 * return (D50).
 */
export function NodeConfigSection() {
  const { connections, dialogs } = useSettingsServices();
  const nodes = useExternal(connections, connections.list).filter((node) => node.state === "open");
  const [nodeId, setNodeId] = useState<string | undefined>();
  const node = nodes.find((candidate) => candidate.id === nodeId) ?? nodes[0];
  /** The editor holds changes not saved yet. */
  const edited = useRef(false);
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
                      edited.current &&
                      dialogs !== undefined &&
                      !(await dialogs.confirm({
                        title: `Discard the changes to ${node.label}'s config?`,
                        description: "They were not saved.",
                        confirmLabel: "Discard",
                        variant: "destructive",
                      }))
                    ) {
                      return;
                    }
                    edited.current = false;
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
      <ConfigEditor
        connection={node}
        key={node.id}
        onEdited={(value) => {
          edited.current = value;
        }}
      />
    </>
  );
}

function ConfigEditor({
  connection,
  onEdited,
}: {
  connection: NodeConnection;
  /** Whether the editor holds changes not saved yet, each time that changes. */
  onEdited(edited: boolean): void;
}) {
  const { context: plugin, mesh, toasts, dialogs } = useSettingsServices();
  const client = connection.client;
  const [schemas, setSchemas] = useState<Readonly<Record<string, JsonSchema>> | undefined>();
  const [section, setSection] = useState<string | undefined>();
  const [layer, setLayer] = useState<ConfigLayer>("node");
  const [loaded, setLoaded] = useLoadedSection(client, section, layer);
  const [asJson, setAsJson] = useState(false);
  const [scope, setScope] = useState<readonly string[] | undefined>();
  /** T3's project scope (D1463): a project of this node, or all of them. */
  const [projectScope, setProjectScope] = useState<string | undefined>();
  const [projects, setProjects] = useState<readonly ScopeProject[]>([]);
  /** The chosen project's `t3.json`, for the settings it backs (D1467). */
  /** `failed`: it could not be read, so its layer is not shown (rather than read as empty). */
  const [t3File, setT3File] = useState<{
    readonly projectId: string;
    readonly file: unknown;
    readonly failed?: boolean;
  }>();
  const [saving, setSaving] = useState(false);
  /** A save in flight reads the section back itself; a change heard meanwhile is skipped. */
  const savingNow = useRef(false);
  /** Grows with every save: a read started before one is older than its read-back. */
  const reads = useRef(0);
  /** The editor as last rendered, for answers that arrive later. */
  const loadedNow = useRef(loaded);
  loadedNow.current = loaded;
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const members = useMeshMembers(mesh, connection.id) ?? [];
  const self = members.find((member) => member.self);

  useEffect(() => {
    // Answers for a client this node no longer has are dropped.
    let current = true;
    void client
      .call<{ properties?: Record<string, JsonSchema> }>("host.config.schema")
      .then((schema) => {
        if (!current) return;
        const next = schema.properties ?? {};
        const names = byTitle(next).map((item) => item.name);
        setSchemas(next);
        setSection((chosen) =>
          chosen !== undefined && names.includes(chosen) ? chosen : names[0],
        );
      })
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

  // The node says the shown section changed, whoever changed it (D484).
  useEffect(() => {
    const subscription = plugin.events.on(NODE_CONFIG_CHANGED, (payload) => {
      const changed = payload as NodeConfigChanged;
      if (section === undefined || savingNow.current) return;
      if (!coversSection(changed, connection.id, section)) return;
      const started = reads.current;
      void client
        .call<ConfigRead>("host.config.get", { section })
        .then((next) => {
          // A save began meanwhile: its read-back is newer than this answer.
          const current = loadedNow.current;
          if (current?.section !== section || started !== reads.current) return;
          // Rebased onto whatever the editor holds by now, edits made during the read included.
          setLoaded((latest) => (latest?.section === section ? rebase(latest, next) : latest));
        })
        // Unreadable now: the next change, a save or a reload reads it again.
        .catch(() => undefined);
    });
    return () => subscription.dispose();
  }, [client, connection.id, section]);

  const read = loaded?.read;
  const edited = loaded !== undefined && !equal(loaded.value, loaded.original);
  useEffect(() => onEdited(edited), [edited]);
  // Gone (another node chosen, or this one disconnected): nothing of it is unsaved.
  useEffect(() => () => onEdited(false), []);

  const names = schemas === undefined ? undefined : byTitle(schemas);
  const schema = section === undefined ? undefined : schemas?.[section];
  const form =
    loaded === undefined ? undefined : sectionForm(loaded.section, schema, read?.comments);
  const errors = loaded === undefined ? new Map<string, string[]>() : errorsOf(schema, loaded);
  // Only JSON can edit a section without keys, or a node file part that is no object.
  const formFits = form !== undefined && form.fields.length > 0 && isObject(loaded?.value);
  const showJson = asJson || !formFits;
  const unknownKeys =
    form === undefined || !isObject(loaded?.value)
      ? []
      : Object.keys(loaded.value).filter((key) => !form.fields.some((field) => field.key === key));

  // The project scope (D1463): a project's entry of the section's `projects` record.
  const entry = projectEntrySchema(schema);
  const scoped =
    projectScope !== undefined && projects.some((project) => project.id === projectScope)
      ? projectScope
      : undefined;
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

  /** Whether unsaved edits may go: they are none, or the user gives them up. */
  const discard = async () =>
    !edited ||
    dialogs === undefined ||
    (await dialogs.confirm({
      title: `Discard the changes to ${loaded.section}?`,
      description: "They were not saved.",
      confirmLabel: "Discard",
      variant: "destructive",
    }));

  /** Another section, once unsaved edits are given up on purpose. */
  const choose = async (next: string) => {
    if (next === section || !(await discard())) return;
    setOutcomes([]);
    setAsJson(false);
    setSection(next);
  };

  /** The other file, once unsaved edits are given up on purpose (D477). */
  const chooseLayer = async (next: ConfigLayer) => {
    if (next === layer || !(await discard())) return;
    setOutcomes([]);
    setLayer(next);
  };
  const other: ConfigLayer = layer === "node" ? "project" : "node";

  const targets = scope ?? (self === undefined ? [] : [self.nodeId]);
  const blocked =
    loaded === undefined ||
    // Another file chosen, and not read yet: the edit is still the old file's.
    loaded.layer !== layer ||
    !isObject(loaded.value) ||
    hasUnparsed(loaded.value) ||
    validate(schema, loaded.value).length > 0;

  const save = async () => {
    if (loaded === undefined || blocked || !isObject(loaded.value)) return;
    // The section the edit was read for, whatever is chosen meanwhile, and the
    // value saved, whatever is changed meanwhile.
    const { section: saved, value: sent, original, layer: file } = loaded;
    // Only the paths that changed are written, so the rest keeps its comments (D84, D476).
    const change = configChange(file, saved, original, sent);
    setSaving(true);
    savingNow.current = true;
    reads.current += 1;
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
        setPending(
          await client.call<Pending[]>("mesh.config.pending").catch(() => pending as Pending[]),
        );
      }
    } catch (error) {
      toasts?.show({
        type: "error",
        title: "Setting not saved",
        description: (error as Error).message,
      });
      return;
    } finally {
      setSaving(false);
      savingNow.current = false;
    }
    // Other plugins follow what the section means (the node icons, `jhin.host`).
    plugin.events.emit("settings.node-config.saved", {
      connection: connection.id,
      section: saved,
    });
    // What the file holds now, if the section is still the one shown.
    try {
      const next = await client.call<ConfigRead>("host.config.get", { section: saved });
      setLoaded((current) => readBack(current, saved, sent, next));
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
            setLoaded((current) =>
              current === undefined
                ? current
                : { ...current, value: setAt(current.value, path, next) ?? {} },
            ),
        };

  const keys = entry === undefined ? [] : projectKeys(entry);
  const entryPath = scoped === undefined ? [] : [PROJECT_SETTINGS_KEY, scoped];
  /** What a file sets for a top-level key: the edited file as edited, the other as read. */
  const nodeSets = (key: string) =>
    getAt(loaded?.value, [key]) ?? getAt(read?.layers[other], [key]);
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
      : sectionForm(loaded.section, projectSchema);
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
            setLoaded((current) => {
              if (current === undefined) return current;
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
            const effective = layers.find((layer) => layer.effective);
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
    <>
      <SettingsSection title={`Config of ${connection.label}`}>
        {names === undefined ? (
          <SettingsEmpty>
            <Spinner size="sm" tone="muted" />
          </SettingsEmpty>
        ) : names.length === 0 ? (
          <SettingsEmpty>This node shares no config sections.</SettingsEmpty>
        ) : (
          <SettingsRow
            control={
              <Select onValueChange={(value) => void choose(String(value))} value={section ?? ""}>
                <SelectTrigger aria-label="Config section" className="w-full sm:w-64" size="sm">
                  <SelectValue>{names.find((item) => item.name === section)?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {names.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.title}
                      {item.title === item.name ? null : (
                        <span className="ms-2 font-mono text-xs text-muted-foreground">
                          {item.name}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
            description="Sections are declared by the node's plugins, each with a schema."
            title="Section"
          />
        )}
        {names === undefined || names.length === 0 ? null : (
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
        )}
      </SettingsSection>
      {loaded === undefined || form === undefined || context === undefined ? null : (
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
          title={form.title}
        >
          {projects.length === 0 || showJson ? null : (
            <ProjectScopeSentence onChange={setProjectScope} projects={projects} value={scoped} />
          )}
          <div className="space-y-1 px-3 py-3 sm:px-4">
            <p className="font-mono text-xs text-muted-foreground">{loaded.section}</p>
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
                  onChange={(next) =>
                    setLoaded((current) =>
                      current === undefined ? current : { ...current, value: next },
                    )
                  }
                  schema={schema ?? {}}
                  label={`${loaded.section} in the ${LAYER_TITLES[layer].toLowerCase()}`}
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
              onClick={() =>
                setLoaded((current) =>
                  current === undefined ? current : { ...current, value: current.original },
                )
              }
              size="sm"
              variant="ghost"
            >
              Discard
            </Button>
            <Button
              // Without the mesh (or before it answers) the change is this node's alone.
              disabled={
                saving || !edited || blocked || (self !== undefined && targets.length === 0)
              }
              onClick={() => void save()}
              size="sm"
            >
              {saving ? <Spinner size="sm" /> : <SaveIcon />}
              Save
            </Button>
          </div>
        </SettingsSection>
      )}
      {pending.length === 0 ? null : (
        <SettingsSection icon={<ClockIcon className="size-4" />} title="Waiting for their node">
          {pending.map((change) => (
            <SettingsRow
              description={`Queued ${new Date(change.queuedAt).toLocaleString()}`}
              key={change.id}
              title={`${change.section} → ${nameOf(change.node)}`}
            />
          ))}
        </SettingsSection>
      )}
    </>
  );
}
