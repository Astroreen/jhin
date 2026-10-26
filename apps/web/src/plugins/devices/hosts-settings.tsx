// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/DeviceHostsSettings.tsx and DeviceHostEditor.tsx, for the one
// node the settings page belongs to (docs/plans/preview.md, D1500).
import type { Connections, NodeConnection } from "@jhin/client-api";
import {
  DEVICES_STREAM,
  DeviceEvents,
  type DeviceHostTestResult,
  type DeviceState,
} from "@jhin/preview-api";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  SettingsRow,
  SettingsSection,
  type Toasts,
} from "@jhin/ui";
import { MoreVertical, PlusIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";

const DEVICES_SECTION = "jhin.devices";

interface HostConfig {
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly identityFile?: string | undefined;
  readonly port?: number | undefined;
}

/** The node this page came from, else the first connected one: the settings' node. */
function settingsNode(connections: Connections): NodeConnection | undefined {
  const open = connections.list().filter((connection) => connection.state === "open");
  return (
    open.find((connection) => {
      if (!URL.canParse(connection.url)) return false;
      const url = new URL(connection.url);
      return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}` === location.origin;
    }) ?? open[0]
  );
}

const randomId = () => `host-${crypto.randomUUID().slice(0, 8)}`;

export function DeviceHostsSection(props: {
  readonly connections: Connections;
  readonly toasts: Toasts | undefined;
}) {
  const node = useExternal(props.connections, () => settingsNode(props.connections));
  return (
    <SettingsSection title="Devices" icon={<SmartphoneIcon className="size-4" />}>
      {node === undefined ? (
        <p className="text-sm text-muted-foreground">Connect a node to manage device hosts.</p>
      ) : (
        <DeviceHosts node={node} toasts={props.toasts} />
      )}
    </SettingsSection>
  );
}

function DeviceHosts(props: {
  readonly node: NodeConnection;
  readonly toasts: Toasts | undefined;
}) {
  const { node, toasts } = props;
  const [hosts, setHosts] = useState<readonly HostConfig[]>([]);
  const [state, setState] = useState<DeviceState | undefined>(undefined);
  const [editing, setEditing] = useState<{ host: HostConfig; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    void node.client
      .call<{ value?: { sshHosts?: HostConfig[] } }>("host.config.get", {
        section: DEVICES_SECTION,
      })
      .then((read) => {
        if (current) setHosts(read.value?.sshHosts ?? []);
      })
      .catch(() => undefined);
    const subscription = node.client.subscribe(DEVICES_STREAM, { after: 0 }, (event) => {
      if (event.type !== DeviceEvents.state) return;
      setState((event.payload as { state: DeviceState }).state);
    });
    return () => {
      current = false;
      subscription.dispose();
    };
  }, [node, revision]);

  const fail = (title: string, error: unknown) =>
    toasts?.show({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });

  /** T3's `updateDeviceHosts`: replace by the original's id, or append, or remove. */
  const save = async (host: HostConfig, remove = false, original = host) => {
    setBusy(true);
    const others = hosts.filter((each) => each.id !== original.id);
    const next = remove
      ? others
      : hosts.some((each) => each.id === original.id)
        ? hosts.map((each) => (each.id === original.id ? host : each))
        : [...others, host];
    try {
      await node.client.call("host.config.patch", {
        layer: "node",
        section: DEVICES_SECTION,
        values: { sshHosts: next },
      });
      setHosts(next);
      setEditing(null);
      setRevision((value) => value + 1);
    } catch (error) {
      fail("Device hosts not saved", error);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (host: HostConfig): Promise<DeviceHostTestResult | undefined> => {
    setChecking(host.id);
    try {
      const result = await node.client.call<DeviceHostTestResult>("device.hosts.test", { host });
      toasts?.show(
        result.status === "failed"
          ? {
              type: "error",
              title: `${host.label}: connection check failed`,
              description: result.error,
            }
          : {
              type: "success",
              title: `${host.label}: connection checks passed`,
              description:
                result.status === "local"
                  ? "Already available locally"
                  : "Connected or already available locally.",
            },
      );
      return result;
    } catch (error) {
      fail(`${host.label}: connection check failed`, error);
      return undefined;
    } finally {
      setChecking(null);
    }
  };

  const retry = (hostId: string) => {
    setRetrying(hostId);
    void node.client
      .call("device.list", { retryHostId: hostId })
      .catch((error: unknown) => fail("Device host not reached", error))
      .finally(() => setRetrying(null));
  };

  return (
    <SettingsRow
      title="Device hosts"
      description="Add remote machines with simulator or emulator runtimes installed, and the selected environments will connect over SSH and set up device tools automatically."
      control={
        <Button
          disabled={busy || editing !== null}
          onClick={() =>
            setEditing({ host: { id: randomId(), label: "", target: "" }, isNew: true })
          }
          size="sm"
          variant="outline"
        >
          <PlusIcon className="size-3.5" /> Add host
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {hosts.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No device hosts.</p>
        ) : null}
        {hosts.map((host) => {
          const status = state?.hostStatuses?.[host.id];
          const summary = state?.hosts.find((each) => each.id === host.id);
          const progress =
            checking === host.id
              ? "Checking connection…"
              : status?.status === "installing"
                ? "Installing device support…"
                : status?.status === "starting"
                  ? "Connecting…"
                  : null;
          const failed = status?.status === "failed";
          return (
            <div
              className="flex items-center gap-2 border-t border-border/50 py-2.5"
              data-device-host={host.id}
              key={host.id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-medium">{host.label}</p>
                  {(summary?.platforms ?? [])
                    .filter((platform) => platform.available)
                    .map((platform) => (
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        key={platform.platform}
                      >
                        {platform.platform === "ios" ? "iOS available" : "Android available"}
                      </span>
                    ))}
                </div>
                <p className="truncate text-xs text-muted-foreground">{host.target}</p>
                {failed && status.detail !== undefined ? (
                  <div className="mt-1" role="status">
                    <details className="text-xs text-destructive">
                      <summary>Connection failed</summary>
                      <p className="mt-1 whitespace-pre-wrap break-words">{status.detail}</p>
                    </details>
                  </div>
                ) : null}
              </div>
              {progress === null ? null : (
                <span className="text-xs text-muted-foreground" role="status">
                  {progress}
                </span>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label={`${host.label} options`}
                      disabled={busy}
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => setEditing({ host, isNew: false })}>Edit</MenuItem>
                  <MenuItem onClick={() => void save(host, true)} variant="destructive">
                    Remove
                  </MenuItem>
                </MenuPopup>
              </Menu>
              <Button
                disabled={busy || (failed ? retrying !== null : progress !== null)}
                onClick={() => {
                  if (failed) retry(host.id);
                  else void testConnection(host);
                }}
                size="sm"
                variant="outline"
              >
                {failed ? (retrying === host.id ? "Retrying…" : "Retry") : "Test connection"}
              </Button>
            </div>
          );
        })}
        {editing === null ? null : (
          <DeviceHostEditor
            busy={busy}
            host={editing.host}
            isNew={editing.isNew}
            key={editing.host.id}
            nodeLabel={node.label ?? node.url}
            onClose={() => setEditing(null)}
            onSave={(host) => void save(host, false, editing.host)}
            testConnection={testConnection}
          />
        )}
      </div>
    </SettingsRow>
  );
}

/** T3's `parseDeviceHostDraft`: a draft that saves, or undefined. */
function parseDraft(draft: {
  id: string;
  label: string;
  target: string;
  identityFile: string;
  port: string;
}): HostConfig | undefined {
  const target = draft.target.trim();
  const label = draft.label.trim() || target;
  const port = draft.port.trim() === "" ? undefined : Number(draft.port);
  if (!/^[^\s-][^\s]*$/.test(target)) return undefined;
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65_535)) {
    return undefined;
  }
  return {
    id: draft.id,
    label,
    target,
    ...(draft.identityFile.trim() === "" ? {} : { identityFile: draft.identityFile.trim() }),
    ...(port === undefined ? {} : { port }),
  };
}

function DeviceHostEditor(props: {
  readonly host: HostConfig;
  readonly isNew: boolean;
  readonly busy: boolean;
  readonly nodeLabel: string;
  readonly onSave: (host: HostConfig) => void;
  readonly onClose: () => void;
  readonly testConnection: (host: HostConfig) => Promise<DeviceHostTestResult | undefined>;
}) {
  const { host, busy } = props;
  const [draft, setDraft] = useState({
    id: host.id,
    label: host.label,
    target: host.target,
    identityFile: host.identityFile ?? "",
    port: host.port === undefined ? "" : String(host.port),
  });
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<DeviceHostTestResult | undefined>(undefined);
  const parsed = parseDraft(draft);
  const field = (key: keyof typeof draft) => (event: { target: { value: string } }) => {
    const value = event.target.value;
    setDraft((current) => ({ ...current, [key]: value }));
    setCheck(undefined);
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
      open
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed !== undefined && draft.label.trim() && !busy && !checking) {
              props.onSave(parsed);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.isNew ? "Add device host" : "Edit device host"}</DialogTitle>
            <DialogDescription>
              Connect from {props.nodeLabel}. Hosts on the same machine are skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <Input
                autoFocus
                disabled={busy}
                onChange={field("label")}
                placeholder="Mac mini"
                required
                value={draft.label}
              />
            </label>
            <label className="mt-3 block space-y-1.5 text-sm">
              <span>SSH target</span>
              <Input
                disabled={busy}
                onChange={field("target")}
                placeholder="user@host or SSH alias"
                required
                value={draft.target}
              />
            </label>
            <details
              className="mt-3 text-sm"
              open={host.port !== undefined || host.identityFile !== undefined || undefined}
            >
              <summary className="cursor-pointer text-muted-foreground">SSH options</summary>
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
                <label className="block space-y-1.5">
                  <span>Identity file</span>
                  <Input
                    disabled={busy}
                    onChange={field("identityFile")}
                    placeholder="SSH config default"
                    value={draft.identityFile}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span>Port</span>
                  <Input
                    disabled={busy}
                    inputMode="numeric"
                    onChange={field("port")}
                    placeholder="Default"
                    value={draft.port}
                  />
                </label>
              </div>
            </details>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1" role="status">
                {checking
                  ? "Checking environments…"
                  : check === undefined
                    ? "Check access before saving"
                    : check.status === "failed"
                      ? `Failed: ${check.error}`
                      : check.status === "local"
                        ? "Already available locally"
                        : "Connection checks passed"}
              </span>
              <Button
                disabled={busy || checking || parsed === undefined}
                onClick={() => {
                  if (parsed === undefined) return;
                  setChecking(true);
                  void props
                    .testConnection(parsed)
                    .then(setCheck)
                    .finally(() => setChecking(false));
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Test connection
              </Button>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button disabled={busy} onClick={props.onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={busy || checking || parsed === undefined || !draft.label.trim()}
              type="submit"
            >
              Save host
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
