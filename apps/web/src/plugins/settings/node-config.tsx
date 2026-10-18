import type { NodeConnection } from "@jhin/client-api";
import {
  Button,
  Checkbox,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from "@jhin/ui";
import { ClockIcon, SaveIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { SettingsEmpty, SettingsRow, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

interface ConfigRead {
  readonly value?: unknown;
  readonly error?: string;
  readonly layers: { readonly node?: unknown; readonly project?: unknown };
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

/**
 * A node's config, section by section (D18–D20): the effective value, the node
 * file's part to edit, and the nodes of the mesh to apply it to — the ones not
 * reachable now get it when they return (D50).
 */
export function NodeConfigSection() {
  const { connections } = useSettingsServices();
  const nodes = useExternal(connections, connections.list).filter((node) => node.state === "open");
  const [nodeId, setNodeId] = useState<string | undefined>();
  const node = nodes.find((candidate) => candidate.id === nodeId) ?? nodes[0];
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
              <Select onValueChange={(value) => setNodeId(String(value))} value={node.id}>
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
      <ConfigEditor connection={node} key={node.id} />
    </>
  );
}

function ConfigEditor({ connection }: { connection: NodeConnection }) {
  const { mesh, toasts } = useSettingsServices();
  const client = connection.client;
  const [sections, setSections] = useState<readonly string[] | undefined>();
  const [section, setSection] = useState<string | undefined>();
  const [read, setRead] = useState<ConfigRead | undefined>();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<readonly string[] | undefined>();
  const [saving, setSaving] = useState(false);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const members = useMeshMembers(mesh, connection.id) ?? [];
  const self = members.find((member) => member.self);

  useEffect(() => {
    void client
      .call<{ properties?: Record<string, unknown> }>("host.config.schema")
      .then((schema) => {
        const names = Object.keys(schema.properties ?? {}).toSorted();
        setSections(names);
        setSection((current) => current ?? names[0]);
      })
      .catch((error: unknown) => {
        setSections([]);
        toasts?.show({
          type: "error",
          title: "Cannot read the config",
          description: (error as Error).message,
        });
      });
    void client
      .call<Pending[]>("mesh.config.pending")
      .then(setPending)
      .catch(() => setPending([]));
  }, [client]);

  useEffect(() => {
    if (section === undefined) return;
    setRead(undefined);
    setOutcomes([]);
    void client
      .call<ConfigRead>("host.config.get", { section })
      .then((next) => {
        setRead(next);
        setText(pretty(next.layers.node));
      })
      .catch((error: unknown) => setRead({ error: (error as Error).message, layers: {} }));
  }, [client, section]);

  const targets = scope ?? (self === undefined ? [] : [self.nodeId]);
  let parsed: Record<string, unknown> | undefined;
  let parseError: string | undefined;
  try {
    const value: unknown = JSON.parse(text === "" ? "{}" : text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    } else {
      parseError = "The section's values must be a JSON object";
    }
  } catch (error) {
    parseError = (error as Error).message;
  }

  const save = async () => {
    if (section === undefined || parsed === undefined) return;
    setSaving(true);
    try {
      const onlySelf = self === undefined || (targets.length === 1 && targets[0] === self.nodeId);
      if (onlySelf) {
        const result = await client.call<{ applied: boolean }>("host.config.patch", {
          layer: "node",
          section,
          values: parsed,
        });
        setOutcomes([
          {
            node: self?.nodeId ?? connection.label,
            status: result.applied ? "applied" : "conflict",
          },
        ]);
      } else {
        const result = await client.call<{ results: Outcome[] }>("mesh.config.patch", {
          nodes: targets,
          layer: "node",
          section,
          values: parsed,
        });
        setOutcomes(result.results);
        setPending(
          await client.call<Pending[]>("mesh.config.pending").catch(() => pending as Pending[]),
        );
      }
      setRead(await client.call<ConfigRead>("host.config.get", { section }));
    } catch (error) {
      toasts?.show({
        type: "error",
        title: "Setting not saved",
        description: (error as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  const nameOf = (nodeId: string) =>
    members.find((member) => member.nodeId === nodeId)?.name ?? nodeId;

  return (
    <>
      <SettingsSection title={`Config of ${connection.label}`}>
        {sections === undefined ? (
          <SettingsEmpty>
            <Spinner size="sm" tone="muted" />
          </SettingsEmpty>
        ) : sections.length === 0 ? (
          <SettingsEmpty>This node shares no config sections.</SettingsEmpty>
        ) : (
          <SettingsRow
            control={
              <Select onValueChange={(value) => setSection(String(value))} value={section ?? ""}>
                <SelectTrigger
                  aria-label="Config section"
                  className="w-full font-mono sm:w-56"
                  size="sm"
                >
                  <SelectValue>{section}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {sections.map((name) => (
                    <SelectItem className="font-mono" key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
            description="Sections are declared by the node's plugins, each with a schema."
            title="Section"
          />
        )}
        {read === undefined || section === undefined ? null : (
          <SettingsRow
            description="What the plugins see now: every layer merged, defaults filled in."
            title="Effective value"
          >
            <pre className="mt-2 mb-2 max-h-56 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs">
              {read.error ?? pretty(read.value)}
            </pre>
          </SettingsRow>
        )}
        {read === undefined || section === undefined ? null : (
          <SettingsRow
            description="This section in the node's config.jsonc. Saving keeps the file's comments; a key left out keeps its value."
            title="Node file"
          >
            <Textarea
              aria-label={`${section} in the node file`}
              className="mt-2 mb-2 font-mono text-xs"
              onChange={(event) => setText(event.target.value)}
              rows={8}
              value={text}
            />
            {parseError === undefined ? null : (
              <p className="mb-2 text-xs text-destructive-foreground" role="alert">
                {parseError}
              </p>
            )}
          </SettingsRow>
        )}
        {members.length > 1 && read !== undefined ? (
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
        {read === undefined ? null : (
          <div className="flex items-center justify-end gap-2 px-3 py-3 sm:px-4">
            {outcomes.length === 0 ? null : (
              <ul aria-label="Outcome" className="me-auto flex flex-wrap gap-x-3 text-xs">
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
            <Button
              disabled={saving || parsed === undefined || targets.length === 0}
              onClick={() => void save()}
              size="sm"
            >
              {saving ? <Spinner size="sm" /> : <SaveIcon />}
              Save
            </Button>
          </div>
        )}
      </SettingsSection>
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
