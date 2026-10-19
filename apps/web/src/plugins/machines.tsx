// The icon menu follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/EnvironmentIconPicker.tsx.
import {
  CONNECTIONS_CAPABILITY,
  HOST_CONFIG_SECTION,
  MACHINE_KIND_LABELS,
  MACHINE_KINDS,
  MACHINES_CAPABILITY,
  THREADS_CAPABILITY,
  isMachineKind,
  type Connections,
  type NodeActionProps,
  type NodeMachines,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";

import { builtin } from "../lib/builtin.ts";
import { MachineIcon } from "../lib/machine-icon.tsx";
import { createNodeMachines, useMachine } from "../lib/machines.ts";

/** What the node config page says after it saved a section (`settings.node-config.saved`). */
const Saved = z.object({ connection: z.string(), section: z.string() });

export const machinesPlugin = builtin(
  "jhin.node-machines",
  {
    provides: { [MACHINES_CAPABILITY]: "1.0.0" },
    requires: { [CONNECTIONS_CAPABILITY]: "^1", [THREADS_CAPABILITY]: "^1" },
    optional: { [UI_SLOTS_CAPABILITY]: "^1", [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const slots = context.services.tryGet<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const machines = context.subscriptions.add(
        createNodeMachines(connections, threads, (error) =>
          context.log.error("a client.machines listener failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      const service: NodeMachines = {
        get: (target) => machines.get(target),
        subscribe: (target, listener) => machines.subscribe(target, listener),
      };
      context.services.provide(MACHINES_CAPABILITY, service);

      // The node config page saved the section by hand: its nodes may show another icon now.
      context.subscriptions.add(
        context.events.on("settings.node-config.saved", (payload) => {
          const saved = Saved.safeParse(payload);
          if (saved.success && saved.data.section === HOST_CONFIG_SECTION)
            machines.refresh({ node: saved.data.connection });
        }),
      );

      context.commands.register({
        name: "node.set-machine",
        title: "Change node icon",
        description:
          "Sets the machine kind a node shows as, for every client of it (jhin.host.machine in its node config); null goes back to what the node detects",
        input: z.object({
          node: z.string(),
          remote: z.string().optional(),
          machine: z.enum(MACHINE_KINDS).nullable(),
        }),
        output: z.object({ applied: z.boolean() }),
        handler: async ({ node, remote, machine }) => {
          if (connections.get(node) === undefined) {
            throw Object.assign(new Error(`Not connected to ${node}`), { code: "NODE_NOT_FOUND" });
          }
          const target = { node, ...(remote === undefined ? {} : { remote }) };
          const result = await threads.call<{ applied: boolean }>(target, "host.config.patch", {
            layer: "node",
            section: HOST_CONFIG_SECTION,
            values: machine === null ? {} : { machine },
            ...(machine === null ? { unset: ["machine"] } : {}),
          });
          machines.refresh(target);
          return { applied: result.applied };
        },
      });

      /** T3's "Icon" submenu of an environment's menu, in settings → Nodes. */
      function IconMenu({ connection }: NodeActionProps) {
        const target = { node: connection.id };
        const machine = useMachine(machines, target);
        const open = connection.state === "open";
        const detected = machine?.detected ?? "server";
        const current = machine?.kind ?? "server";
        return (
          <MenuSub>
            <MenuSubTrigger>
              <MachineIcon kind={current} />
              Icon
            </MenuSubTrigger>
            <MenuSubPopup>
              {open ? null : (
                <>
                  <MenuItem className="whitespace-normal" disabled>
                    Connect to this node to change its icon.
                  </MenuItem>
                  <MenuSeparator />
                </>
              )}
              <MenuRadioGroup
                value={current}
                onValueChange={(next: unknown) => {
                  if (!open || !isMachineKind(next) || next === current) return;
                  // The detected kind is no choice: the node keeps following what it detects.
                  context.commands
                    .execute("node.set-machine", {
                      node: connection.id,
                      machine: next === detected ? null : next,
                    })
                    .catch((error: unknown) =>
                      toasts?.show({
                        type: "error",
                        title: "Icon not changed",
                        description: (error as Error).message,
                      }),
                    );
                }}
              >
                {MACHINE_KINDS.map((kind) => (
                  <MenuRadioItem disabled={!open} key={kind} value={kind}>
                    <span className="flex min-w-0 items-center gap-2">
                      <MachineIcon className="size-3.5 shrink-0" kind={kind} />
                      <span className="min-w-0 flex-1 truncate">{MACHINE_KIND_LABELS[kind]}</span>
                      {kind === detected ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {machine?.detected === undefined ? "default" : "detected"}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        );
      }
      if (slots !== undefined)
        context.subscriptions.add(
          slots.contribute<NodeActionProps>("node.actions", {
            id: "jhin.node-machines.icon",
            order: 3,
            component: IconMenu,
          }),
        );
    },
  }),
);
