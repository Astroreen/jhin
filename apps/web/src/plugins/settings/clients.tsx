// The authorized clients of a node and its pairing links (security.md D424),
// following T3 Code's connections settings (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/ConnectionsSettings.tsx — its wording, the
// "Create pairing link" dialog and the QR code of the link.
import type { NodeConnection } from "@jhin/client-api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Label,
  Spinner,
  copyText,
} from "@jhin/ui";
import { CopyIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { QRCodeSvg } from "../../lib/qr-code-svg.tsx";
import { httpBase } from "../../lib/session.ts";
import { SettingsEmpty, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

interface Client {
  readonly id: string;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly method: "pairing" | "issued";
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly lastSeenAt?: number;
  readonly current: boolean;
}

/** An entry of `auth.permissions.list`, titled by its plugin (security.md D961). */
interface Permission {
  readonly permission: string;
  readonly title?: string;
  readonly description?: string;
}

interface PairingLink {
  readonly id: string;
  readonly label?: string;
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}

interface CreatedLink extends PairingLink {
  readonly code: string;
  readonly url: string;
}

const when = (time: number) => new Date(time).toLocaleString();

function CreateLinkDialog(props: { node: NodeConnection; onClose(): void; onCreated(): void }) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [permissions, setPermissions] = useState<readonly Permission[] | undefined>();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [bases, setBases] = useState<readonly string[]>([httpBase(props.node.url)]);
  const [base, setBase] = useState(httpBase(props.node.url));
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<CreatedLink | undefined>();
  // One link per submit: a double click must not leave a second, unseen code open.
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // An answer after the dialog closed (or switched node) changes nothing.
    let alive = true;
    const { client } = props.node;
    client.call<{ permissions: Permission[] }>("auth.permissions.list").then(
      ({ permissions: listed }) => {
        if (!alive) return;
        setPermissions(listed);
        setChosen(new Set(listed.map((entry) => entry.permission)));
      },
      (failure: unknown) => alive && setError((failure as Error).message),
    );
    // The node's own address, next to the one this device reaches it at.
    client.call<{ url: string }>("http.info").then(
      ({ url }) => alive && setBases((current) => [...new Set([...current, url])]),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [props.node]);

  const everything = permissions !== undefined && chosen.size === permissions.length;
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : props.onClose())} open>
      <DialogPopup className="sm:max-w-md">
        {created === undefined ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen.size === 0) {
                setError("Select at least one permission.");
                return;
              }
              if (submitting) return;
              setSubmitting(true);
              props.node.client
                .call<CreatedLink>("auth.pairing.create", {
                  ...(label.trim() === "" ? {} : { label: label.trim() }),
                  // Every permission ticked: what this device holds, as T3's standard scopes.
                  ...(everything ? {} : { permissions: [...chosen] }),
                  baseUrl: base,
                })
                .then(
                  (link) => {
                    setCreated(link);
                    props.onCreated();
                  },
                  (failure: unknown) => setError((failure as Error).message),
                )
                .finally(() => setSubmitting(false));
            }}
          >
            <DialogHeader>
              <DialogTitle>Create pairing link</DialogTitle>
              <DialogDescription>
                Generate a one-time link that another device can use to pair with this backend as an
                authorized client.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              <Label className="flex flex-col items-stretch gap-1.5" htmlFor={`${id}-label`}>
                Client label (optional)
                <Input
                  id={`${id}-label`}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Living room iPad"
                  value={label}
                />
              </Label>
              {bases.length > 1 ? (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 text-sm font-medium">Reach this machine via</legend>
                  {bases.map((option) => (
                    <Label className="flex items-center gap-2 font-normal" key={option}>
                      <input
                        checked={base === option}
                        name={`${id}-base`}
                        onChange={() => setBase(option)}
                        type="radio"
                      />
                      <code className="text-xs">{option}</code>
                    </Label>
                  ))}
                </fieldset>
              ) : null}
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm font-medium">Permissions</legend>
                <p className="mb-1.5 text-xs text-muted-foreground">
                  Limit what the paired client can do.
                </p>
                {permissions === undefined ? (
                  error === undefined ? (
                    <Spinner size="sm" tone="muted" />
                  ) : (
                    // The node did not say what it grants: no spinner forever.
                    <p className="text-sm text-muted-foreground">
                      The permissions could not be read from this node.
                    </p>
                  )
                ) : (
                  <div className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-lg border">
                    {permissions.map(({ permission, title, description }) => (
                      <Label
                        className="flex cursor-pointer items-start gap-3 px-3 py-2.5 font-normal transition-colors hover:bg-muted/40"
                        key={permission}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={chosen.has(permission)}
                          onCheckedChange={(checked) => {
                            // A choice made answers "Select at least one permission."
                            setError(undefined);
                            setChosen((current) => {
                              const next = new Set(current);
                              if (checked) next.add(permission);
                              else next.delete(permission);
                              return next;
                            });
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">
                            {title ?? permission}
                          </span>
                          {description === undefined ? null : (
                            <span className="block text-xs leading-snug text-muted-foreground">
                              {description}
                            </span>
                          )}
                          {title === undefined ? null : (
                            <code className="block text-[11px] text-muted-foreground">
                              {permission}
                            </code>
                          )}
                        </span>
                      </Label>
                    ))}
                  </div>
                )}
              </fieldset>
              {error === undefined ? null : (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button onClick={props.onClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={permissions === undefined || submitting} type="submit">
                Create link
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Pairing link — scan to open on another device</DialogTitle>
              <DialogDescription>Valid once, until {when(created.expiresAt)}.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col items-center gap-4">
              <QRCodeSvg
                className="rounded-md"
                marginSize={2}
                size={208}
                title="Pairing link QR code"
                value={created.url}
              />
              <div className="flex w-full items-center gap-2">
                <Input aria-label="Pairing link" readOnly value={created.url} />
                <Button
                  aria-label="Copy pairing link"
                  onClick={() => void copyText(created.url)}
                  size="icon-sm"
                  variant="outline"
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
              <div className="flex w-full items-center gap-2">
                <Input aria-label="Pairing code" readOnly value={created.code} />
                <Button
                  aria-label="Copy pairing code"
                  onClick={() => void copyText(created.code)}
                  size="icon-sm"
                  variant="outline"
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button onClick={props.onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function NodeClients({ node }: { node: NodeConnection }) {
  const [clients, setClients] = useState<readonly Client[] | undefined>();
  const [links, setLinks] = useState<readonly PairingLink[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [confirmingOthers, setConfirmingOthers] = useState(false);
  const [pending, setPending] = useState(false);
  // Answers that come after this node's section is gone change nothing.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const load = useCallback(() => {
    Promise.all([
      node.client.call<{ clients: Client[] }>("auth.clients.list"),
      node.client.call<{ links: PairingLink[] }>("auth.pairing.list"),
    ]).then(
      ([listed, open]) => {
        if (!mounted.current) return;
        setClients(listed.clients);
        setLinks(open.links);
        setError(undefined);
      },
      (failure: unknown) => mounted.current && setError((failure as Error).message),
    );
  }, [node]);
  useEffect(load, [load]);
  // One change at a time: the buttons wait for the node's answer.
  const run = (method: string, input: unknown) => {
    setPending(true);
    return node.client
      .call(method, input)
      .then(load, (failure: unknown) => mounted.current && setError((failure as Error).message))
      .finally(() => mounted.current && setPending(false));
  };

  return (
    <SettingsSection
      headerAction={
        <div className="flex items-center gap-1">
          {clients !== undefined && clients.some((client) => !client.current) ? (
            <Button
              disabled={pending}
              onClick={() => setConfirmingOthers(true)}
              size="xs"
              variant="ghost-muted"
            >
              Revoke others
            </Button>
          ) : null}
          <Button onClick={() => setCreating(true)} size="xs" variant="ghost-muted">
            <PlusIcon className="size-3" />
            <span>Create link</span>
          </Button>
        </div>
      }
      title={`Authorized clients — ${node.label}`}
    >
      {error !== undefined ? (
        <p className="px-4 text-sm text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : clients === undefined ? (
        <div className="px-4">
          <Spinner size="sm" tone="muted" />
        </div>
      ) : clients.length === 0 && links.length === 0 ? (
        <SettingsEmpty>No pairing links or client sessions.</SettingsEmpty>
      ) : (
        <ul aria-label={`Authorized clients of ${node.label}`} className="flex flex-col">
          {links.map((link) => (
            <li
              className="flex items-start justify-between gap-3 px-3 py-2.5 sm:px-4"
              key={link.id}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{link.label ?? "Pairing link"}</p>
                <p className="text-xs text-muted-foreground">
                  Not connected yet. Expires {when(link.expiresAt)}.
                </p>
              </div>
              <Button
                aria-label={`Revoke pairing link ${link.label ?? link.id}`}
                disabled={pending}
                onClick={() => void run("auth.pairing.revoke", { id: link.id })}
                size="xs"
                variant="outline"
              >
                Revoke
              </Button>
            </li>
          ))}
          {clients.map((client) => (
            <li
              className="flex items-start justify-between gap-3 px-3 py-2.5 sm:px-4"
              key={client.id}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {client.label}
                  {client.current ? (
                    <Badge size="sm" variant="secondary">
                      This device
                    </Badge>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {client.lastSeenAt === undefined
                    ? "Not connected yet."
                    : `Connected ${when(client.lastSeenAt)}`}
                  {client.expiresAt === undefined ? "" : ` · Expires ${when(client.expiresAt)}`}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Granted scopes: <code>{client.permissions.join(", ")}</code>
                </p>
              </div>
              {client.current ? null : (
                <Button
                  aria-label={`Revoke ${client.label}`}
                  disabled={pending}
                  onClick={() => void run("auth.clients.revoke", { id: client.id })}
                  size="xs"
                  variant="outline"
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog onOpenChange={setConfirmingOthers} open={confirmingOthers}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke other clients?</AlertDialogTitle>
            <AlertDialogDescription>
              Other paired clients will need a new pairing link before reconnecting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setConfirmingOthers(false);
                void run("auth.clients.revoke-others", {});
              }}
              variant="destructive"
            >
              Revoke others
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {creating ? (
        <CreateLinkDialog node={node} onClose={() => setCreating(false)} onCreated={load} />
      ) : null}
    </SettingsSection>
  );
}

export function ClientsSection() {
  const { connections } = useSettingsServices();
  const nodes = useExternal(connections, connections.list).filter((node) => node.state === "open");
  if (nodes.length === 0) return <SettingsEmpty>No node connected.</SettingsEmpty>;
  return (
    <div className="flex flex-col gap-8">
      {nodes.map((node) => (
        <NodeClients key={node.id} node={node} />
      ))}
    </div>
  );
}
