// The device hub of the node (D1206–D1209): the toolchain, the host, the proxy and the input,
// put together as T3's DeviceService does it for its local host (MIT, see THIRD_PARTY_NOTICES.md:
// apps/server/src/device/DeviceService.ts, `readiness` and `readinessIfSupported`), without Effect.
import * as Path from "node:path";

import type { AuthVerifier } from "@jhin/auth-api";
import type { HttpServer } from "@jhin/http-api";
import {
  DEVICE_HUB_PATH,
  DeviceError,
  type DeviceHostStatus,
  type DeviceHostSummary,
  type DeviceHubAccessResult,
  type DeviceInput,
  type DeviceSummary,
} from "@jhin/preview-api";

import { missingPermissions } from "@jhin/sdk";

import { runAgentDeviceInput } from "./agent-device.ts";
import { createHubHost, failureDetail } from "./hub-host.ts";
import { TICKET_PARAM, createTickets, serveHubProxy } from "./hub-proxy.ts";
import { createToolchain } from "./toolchain.ts";

/** How long a request waits on an install or start in progress (D951's 45 s, as T3 waits). */
const WAIT_MS = 45_000;

export interface DeviceHubOptions {
  /** Jhin's home (`host.paths@1`); without one nothing is installed. */
  readonly home: string | undefined;
  /** Where agent-device keeps its daemon state (the plugin's data). */
  readonly stateDir: string | undefined;
  readonly enabled: () => boolean;
  /** Agents may use the agent tools (`jhin.devices.agentAccess`, D1329). */
  readonly agentAccess: () => boolean;
  readonly node: () => string | undefined;
  readonly npm: () => string | undefined;
  readonly androidSdk: () => string | undefined;
  readonly summary: () => DeviceHostSummary;
  /** The local adb path (D408), for input when agent tools cannot start. */
  readonly adbInput: (device: DeviceSummary, input: DeviceInput) => Promise<void>;
  readonly http: HttpServer | undefined;
  readonly verifier: AuthVerifier | undefined;
  readonly onStatus: (status: DeviceHostStatus) => void;
  /** The agent tools stopped being ready outside a status change (their daemon died). */
  readonly onAgentGone?: () => void;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
  readonly env?: NodeJS.ProcessEnv;
}

/** Waits on `work` a while; past that, `late` says why, and the work goes on. */
async function within<T>(work: Promise<T>, late: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), WAIT_MS);
  });
  try {
    const result = await Promise.race([work, waited]);
    if (result === "late") throw late();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function createDeviceHub(options: DeviceHubOptions) {
  let status: DeviceHostStatus | undefined;
  const setStatus = (next: DeviceHostStatus) => {
    status = next;
    options.onStatus(next);
  };
  const tickets = createTickets();
  const host =
    options.home === undefined || options.stateDir === undefined
      ? undefined
      : createHubHost({
          toolchain: createToolchain({
            home: options.home,
            npm: options.npm,
            ...(options.env === undefined ? {} : { env: options.env }),
          }),
          home: options.home,
          stateDir: Path.join(options.stateDir, "agent-device"),
          node: options.node,
          androidSdk: options.androidSdk,
          ...(options.env === undefined ? {} : { env: options.env }),
          onStatus: (next, detail) =>
            setStatus({ status: next, ...(detail === undefined ? {} : { detail }) }),
          log: options.log,
        });
  const proxy =
    host === undefined || options.http === undefined || options.verifier === undefined
      ? undefined
      : serveHubProxy({
          http: options.http,
          verifier: options.verifier,
          tickets,
          // Off, the hub is gone for clients at once (503), as it stops.
          origin: () => (options.enabled() ? host.current() : undefined),
        });

  /** Why the hub cannot run here, or undefined when it can (T3's `readinessIfSupported`). */
  const unavailable = (): string | undefined => {
    if (!options.enabled())
      return "Video and input need the device hub. Turn it on with Devices → Device hub (jhin.devices.hub).";
    if (host === undefined) return "The device hub needs Jhin's home to install into.";
    const platforms = options.summary().platforms;
    if (!platforms.some((platform) => platform.available)) {
      return platforms.map((platform) => platform.reason).join(" ");
    }
    return undefined;
  };

  const late = () =>
    new DeviceError(
      "DEVICE_UNAVAILABLE",
      `${status?.detail ?? "Starting the device hub…"} Try again in a minute.`,
    );

  const ensureHub = () => {
    const reason = unavailable();
    if (reason !== undefined || host === undefined) {
      return Promise.reject(new DeviceError("DEVICE_UNAVAILABLE", reason ?? ""));
    }
    return host.ensureHub();
  };

  return {
    /** Starts the hub ahead of a client asking for it (a device opened); failures are logged. */
    warm(): void {
      if (unavailable() !== undefined) return;
      void ensureHub().catch((error: unknown) =>
        options.log("device hub not started", { error: failureDetail(error) }),
      );
    },

    /** The hub's path and a ticket for `caller`, once it runs (D1208). */
    async access(caller: {
      id: string;
      permissions: readonly string[];
    }): Promise<DeviceHubAccessResult> {
      if (proxy === undefined) {
        throw new DeviceError(
          "DEVICE_UNAVAILABLE",
          unavailable() ?? "This node serves no HTTP, so clients cannot reach its device hub.",
        );
      }
      // Watching never installs or starts anything: that takes devices.write (opening a
      // device starts the hub too).
      if (
        host?.current() === undefined &&
        missingPermissions(caller.permissions, ["devices.write"]).length > 0
      ) {
        throw new DeviceError(
          "DEVICE_UNAVAILABLE",
          "The device hub is not running. Open the device to start it.",
        );
      }
      await within(
        ensureHub().catch((error: unknown) => {
          if (error instanceof DeviceError) throw error;
          throw new DeviceError("DEVICE_UNAVAILABLE", failureDetail(error));
        }),
        late,
      );
      const media = tickets.issue(caller, "media");
      const socket = tickets.issue(caller, "socket");
      return {
        path: DEVICE_HUB_PATH,
        query: { [TICKET_PARAM]: media.ticket },
        socketQuery: { [TICKET_PARAM]: socket.ticket },
        expiresAt: media.expiresAt,
      };
    },

    /**
     * An input through agent-device, else through adb (D408's path) when agent tools cannot
     * run, are still installing, or their daemon does not answer before the command. adb
     * never repeats an input agent-device may have carried out: once the command ran, its
     * failure (a refusal, a timeout, the daemon dying) is the answer.
     */
    async input(
      threadId: string,
      device: DeviceSummary,
      input: DeviceInput,
    ): Promise<"agent-device" | "adb"> {
      let reason =
        unavailable() ??
        (options.agentAccess()
          ? undefined
          : "Agents may not use the device tools on this node (jhin.devices.agentAccess).");
      if (reason === undefined && host !== undefined && options.stateDir !== undefined) {
        try {
          const endpoint = await within(host.ensureAgent(options.agentAccess), late);
          try {
            await runAgentDeviceInput({
              endpoint,
              stateDir: Path.join(options.stateDir, "agent-device"),
              threadId,
              device,
              input,
              ...(options.env === undefined ? {} : { env: options.env }),
            });
          } catch (error) {
            // A daemon that died is started again by the next input; this one may have run.
            if (error instanceof DeviceError && error.code === "DEVICE_OPERATION_FAILED") {
              if (!(await host.agentAlive(endpoint))) {
                host.forgetAgent();
                options.onAgentGone?.();
              }
            }
            throw error;
          }
          return "agent-device";
        } catch (error) {
          if (error instanceof DeviceError && error.code === "DEVICE_OPERATION_FAILED") throw error;
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      options.log("device input through adb", { reason });
      await options.adbInput(device, input);
      return "adb";
    },

    /**
     * Agent access was turned on: the agent tools install and start now (T3's
     * `agentReadinessIfSupported`); failures show in the status.
     */
    warmAgent(): void {
      if (unavailable() !== undefined || host === undefined || !options.agentAccess()) return;
      void host
        .ensureAgent(options.agentAccess)
        .catch((error: unknown) =>
          options.log("agent tools not started", { error: failureDetail(error) }),
        );
    },

    /** Agent access was turned off: their daemon stops, the hub runs on. */
    async stopAgent(): Promise<void> {
      await host?.stopAgent();
    },

    agentReady: (): boolean => host?.agentReady() ?? false,

    /**
     * The setting was turned off: tickets and proxied sockets go, the hub and its daemon
     * stop (an install in progress too); turning it on starts them with the next request.
     */
    async disable(): Promise<void> {
      tickets.revoke();
      proxy?.drop();
      await host?.stop(true);
      // Turned on again meanwhile: the next request starts it, and its status says so.
      if (!options.enabled()) setStatus({ status: "idle", detail: unavailable() ?? "" });
    },

    /** A token that went takes its tickets and proxied sockets with it (security.md D414). */
    revoke(principal?: string): void {
      tickets.revoke(principal);
      proxy?.drop(principal);
    },

    current: () => host?.current(),

    /** Stops the proxy, the hub and the daemon (every registration returns a disposable). */
    async stop(): Promise<void> {
      proxy?.dispose();
      tickets.revoke();
      await host?.stop();
    },
  };
}
