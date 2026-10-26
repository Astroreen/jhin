// Devices follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/device.ts (the
// summaries, hosts, sessions, the tools' inputs and results and the errors' wording) and
// apps/server/src/mcp/toolkits/device/tools.ts.
import { z } from "@jhin/sdk";

/** `device.hosts@1`: the simulators and emulators of the node (D408). */
export const DEVICE_HOSTS_CAPABILITY = "device.hosts";

/** The node's devices and every thread's open ones: one `device.state` event after a change. */
export const DEVICES_STREAM = "devices";
export const DEVICE_STREAM_PREFIX = "device/";
/** One device's newest screen, taken while a client watches it. */
export const deviceStream = (hostId: string, deviceId: string): string =>
  `${DEVICE_STREAM_PREFIX}${hostId}/${encodeURIComponent(deviceId)}`;

export const DeviceEvents = {
  /** `{ state }`: the `DeviceState` after a change. */
  state: "device.state",
  /** `{ data, width, height }`: a PNG of the device's screen (base64). */
  screen: "device.screen",
} as const;

/**
 * Where the node's HTTP server proxies T3's device hub for authenticated clients (D1208):
 * `<node>/device-hub/vendor/serve-sim/…` and `<node>/device-hub/vendor/serve-emu/…`.
 */
export const DEVICE_HUB_PATH = "/device-hub";

/** The node itself; other hosts are reached over SSH (preview.md D1494). */
export const LOCAL_DEVICE_HOST_ID = "local";

export const DevicePlatform = z.enum(["ios", "android"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const DeviceId = z.string().trim().min(1).max(256);
export const DeviceHostId = z.string().trim().min(1).max(128);

export const DeviceSummary = z.object({
  hostId: z.string(),
  id: z.string(),
  platform: DevicePlatform,
  name: z.string(),
  version: z.string(),
  booted: z.boolean(),
  physical: z.boolean(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const DevicePlatformAvailability = z.object({
  platform: DevicePlatform,
  available: z.boolean(),
  reason: z.string().optional(),
});

export const DeviceHostSummary = z.object({
  id: z.string(),
  /** `ssh`: a machine the node reaches over SSH (D1494). */
  kind: z.enum(["local", "ssh"]),
  label: z.string(),
  platforms: z.array(DevicePlatformAvailability),
});
export type DeviceHostSummary = z.infer<typeof DeviceHostSummary>;

export const DeviceSession = z.object({
  threadId: z.string(),
  hostId: z.string(),
  deviceId: z.string(),
  platform: DevicePlatform,
  openedAt: z.string(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** Where a host's device hub is (D1207): T3's host statuses. */
export const DeviceHostStatus = z.object({
  status: z.enum(["idle", "installing", "starting", "ready", "failed"]),
  /** "Installing device hub 0.15.3…", or why it failed. */
  detail: z.string().optional(),
});
export type DeviceHostStatus = z.infer<typeof DeviceHostStatus>;

/** What the `devices` stream and `device.state` give. */
export const DeviceState = z.object({
  hosts: z.array(DeviceHostSummary),
  devices: z.array(DeviceSummary),
  sessions: z.array(DeviceSession),
  /** Devices starting for a thread ("Starting …"). */
  booting: z.array(z.object({ hostId: z.string(), deviceId: z.string(), threadId: z.string() })),
  /** Why the last listing failed, when it did. */
  detail: z.string().optional(),
  /** Each host's device hub by host id, once one was asked for (D1207). */
  hostStatuses: z.record(z.string(), DeviceHostStatus).optional(),
  /** The node's device setup (T3's settings and onboarding, D1328). */
  setup: z
    .object({
      hubEnabled: z.boolean(),
      agentAccessEnabled: z.boolean(),
      onboardingCompleted: z.boolean(),
      /** agent-device runs for agents (D1329). */
      agentToolsReady: z.boolean(),
    })
    .optional(),
});
export type DeviceState = z.infer<typeof DeviceState>;

export type DeviceErrorCode =
  | "DEVICE_UNAVAILABLE"
  | "DEVICE_PLATFORM_UNAVAILABLE"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_BOOT_FAILED"
  | "DEVICE_OPERATION_FAILED"
  /** `details.reason`: `unsupported` on the platform, or `helper_missing` (D1332). */
  | "DEVICE_ACTION_UNAVAILABLE";

export class DeviceError extends Error {
  readonly code: DeviceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DeviceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
    this.details = details;
  }
}

const ThreadId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "letters, digits, . _ : -")
  .describe("The thread whose Device panel to use.");

export const DeviceListInput = z.object({
  threadId: ThreadId.optional(),
  hostId: DeviceHostId.optional().describe("Limit to one device host. Defaults to all hosts."),
  /** T3's `retryHostId`: connect a failed host again (D1497). */
  retryHostId: DeviceHostId.optional(),
});

export const DeviceListResult = z.object({
  hosts: z.array(DeviceHostSummary),
  devices: z.array(DeviceSummary),
  open: z.array(z.object({ hostId: z.string(), deviceId: z.string() })),
});

export const DeviceOpenInput = z.object({
  threadId: ThreadId,
  deviceId: DeviceId.optional().describe(
    "Simulator udid or emulator serial (or AVD name) from device_list. Omit to use the booted device for the platform, or the first one.",
  ),
  platform: DevicePlatform.optional().describe(
    "Required when deviceId is omitted and both platforms are available.",
  ),
  hostId: DeviceHostId.optional().describe("Device host from device_list. Defaults to local."),
});
export type DeviceOpenInput = z.infer<typeof DeviceOpenInput>;

export const DeviceOpenResult = z.object({
  device: DeviceSummary,
  control: z.object({
    command: z.string().describe("The executable that drives the device."),
    targetArgs: z.array(z.string()).describe("Arguments that pin it to this device."),
  }),
  quickStart: z.string(),
});
export type DeviceOpenResult = z.infer<typeof DeviceOpenResult>;

export const DeviceTargetInput = z.object({
  threadId: ThreadId,
  deviceId: DeviceId.optional().describe(
    "Device from device_list. Omit to use the device most recently opened in this thread.",
  ),
  hostId: DeviceHostId.optional(),
});
export type DeviceTargetInput = z.infer<typeof DeviceTargetInput>;

export const DeviceScreenshotResult = z.object({
  device: DeviceSummary,
  screenshot: z.object({
    mimeType: z.literal("image/png"),
    data: z.string(),
    width: z.number().int(),
    height: z.number().int(),
  }),
});

export const DeviceCloseInput = z.object({
  threadId: ThreadId,
  deviceId: DeviceId.optional().describe(
    "Device to close. Omit to close every device in this thread.",
  ),
  hostId: DeviceHostId.optional(),
  shutdown: z
    .boolean()
    .optional()
    .describe("Also power the simulator or emulator off. Defaults to false."),
});
export type DeviceCloseInput = z.infer<typeof DeviceCloseInput>;

export const DeviceHubAccessInput = z.object({
  hostId: DeviceHostId.optional().describe("Device host from device_list. Defaults to local."),
});

/** How a client reaches the hub through the node: its path and a ticket for its query (D1208). */
export const DeviceHubAccessResult = z.object({
  path: z.string().describe("The hub's path on the node's HTTP server."),
  query: z
    .record(z.string(), z.string())
    .describe(
      "Query parameters the hub's HTTP URLs carry: a short-lived ticket that only watches.",
    ),
  socketQuery: z
    .record(z.string(), z.string())
    .describe("Query parameters the hub's WebSocket URLs carry: a ticket for the caller's grants."),
  expiresAt: z.number().int().describe("When the ticket stops working (ms since the epoch)."),
});
export type DeviceHubAccessResult = z.infer<typeof DeviceHubAccessResult>;

const Coordinate = z.number().min(0).max(100_000);
const Point = z.object({ x: Coordinate, y: Coordinate });
const Button = z.enum(["home", "back", "appSwitcher"]);

/** An input to a device (D1209), as agent-device takes it: coordinates are the device's own. */
export const DeviceInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: Coordinate, y: Coordinate }),
  z.object({ type: z.literal("swipe"), from: Point, to: Point }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("button"), button: Button }),
]);
export type DeviceInput = z.infer<typeof DeviceInput>;

export const DeviceTapInput = DeviceTargetInput.extend({
  x: Coordinate.describe("Horizontal position in the device's screen coordinates."),
  y: Coordinate.describe("Vertical position in the device's screen coordinates."),
});
export const DeviceSwipeInput = DeviceTargetInput.extend({
  from: Point.describe("Where the swipe starts, in the device's screen coordinates."),
  to: Point.describe("Where the swipe ends."),
});
export const DeviceTypeInput = DeviceTargetInput.extend({
  text: z.string().min(1).max(10_000).describe("Text to type into the focused field."),
});
export const DeviceButtonInput = DeviceTargetInput.extend({
  button: Button.describe(
    "The hardware button: home, back (Android) or appSwitcher (the recent apps).",
  ),
});

export const DeviceInputResult = z.object({
  device: DeviceSummary,
  via: z
    .enum(["agent-device", "adb"])
    .describe("agent-device, or adb when agent tools could not start (D408's path)."),
});

/** Width and height of a PNG, from its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 };
  const read = (at: number) =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  return { width: read(16), height: read(20) };
}

// --- The device tools panel (T3's `DeviceActionInput` and `DeviceDetail`, D1332) ---------

export const DeviceAppearance = z.enum(["light", "dark"]);
export const DeviceTextSize = z.enum(["small", "default", "large", "extra-large"]);
export type DeviceTextSize = z.infer<typeof DeviceTextSize>;
export const DeviceColorFilter = z.enum([
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
]);
export const DeviceOrientation = z.enum([
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
]);
export type DeviceOrientation = z.infer<typeof DeviceOrientation>;

export const DeviceSettings = z.object({
  appearance: DeviceAppearance.optional(),
  textSize: DeviceTextSize.optional(),
  reduceMotion: z.boolean().optional(),
  increaseContrast: z.boolean().optional(),
  reduceTransparency: z.boolean().optional(),
  showBorders: z.boolean().optional(),
  voiceOver: z.boolean().optional(),
  liquidGlass: z.enum(["clear", "tinted"]).optional(),
  colorFilter: DeviceColorFilter.optional(),
  networkEnabled: z.boolean().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional(),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;

export const DeviceForegroundApp = z.object({
  id: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
});
export type DeviceForegroundApp = z.infer<typeof DeviceForegroundApp>;

export const DeviceDetail = z.object({
  hostId: z.string(),
  deviceId: z.string(),
  settings: DeviceSettings,
  foregroundApp: DeviceForegroundApp.nullable(),
  readAt: z.string(),
  /**
   * `device.action` took, but the settings could not be read back after it (D1332): `settings`
   * is then empty and says nothing of the device; a client keeps what it last read.
   */
  readError: z.string().optional(),
});
export type DeviceDetail = z.infer<typeof DeviceDetail>;

export const DevicePermission = z.enum([
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "location",
  "notifications",
  "motion",
  "media-library",
  "faceid",
]);
export type DevicePermission = z.infer<typeof DevicePermission>;

/** A bundle id (iOS) or package name (Android): letters, digits, `.`, `_` and `-`. */
const AppId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a bundle id or package name");

/** One of the tools panel's actions (T3's `DeviceActionInput` without its target). */
export const DeviceAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setAppearance"), value: DeviceAppearance }),
  z.object({ type: z.literal("setTextSize"), value: DeviceTextSize }),
  z.object({
    type: z.literal("setToggle"),
    setting: z.enum([
      "reduceMotion",
      "increaseContrast",
      "reduceTransparency",
      "showBorders",
      "voiceOver",
      "networkEnabled",
    ]),
    value: z.boolean(),
  }),
  z.object({ type: z.literal("setLiquidGlass"), value: z.enum(["clear", "tinted"]) }),
  z.object({ type: z.literal("setColorFilter"), value: DeviceColorFilter }),
  z.object({ type: z.literal("setOrientation"), value: DeviceOrientation }),
  z.object({
    type: z.literal("setLocation"),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  z.object({ type: z.literal("clearLocation") }),
  z.object({
    type: z.literal("setPermission"),
    appId: AppId,
    permission: DevicePermission,
    decision: z.enum(["grant", "revoke", "reset"]),
  }),
  z.object({
    type: z.literal("openUrl"),
    // A URL with its scheme (`https:`, `myapp:`), so nothing reads it as an option.
    url: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z][A-Za-z0-9+.-]*:\S*$/, "a URL with its scheme"),
  }),
  z.object({ type: z.literal("launchApp"), appId: AppId }),
  z.object({ type: z.literal("terminateApp"), appId: AppId }),
  z.object({
    type: z.literal("sendPush"),
    appId: AppId,
    // As text or as JSON, at most 4096 characters, as APNs bounds a push.
    payload: z.union([
      z.string().max(4096),
      z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 4096, {
        message: "A push payload is at most 4096 characters as JSON.",
      }),
    ]),
  }),
]);
export type DeviceAction = z.infer<typeof DeviceAction>;

export const DeviceActionInput = DeviceTargetInput.extend({ action: DeviceAction });
export type DeviceActionInput = z.infer<typeof DeviceActionInput>;

/** A device host over SSH, as `jhin.devices.sshHosts` lists it (T3's `SshDeviceHostConfig`, D1494). */
export const SshDeviceHostConfigInput = z.object({
  id: DeviceHostId,
  label: z.string().trim().min(1),
  target: z.string().trim().min(1),
  identityFile: z.string().trim().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
});

/** `device.hosts.test`: T3's connection check of a host (D1500). */
export const DeviceHostTestInput = z.object({ host: SshDeviceHostConfigInput });
export const DeviceHostTestResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("connected"),
    platforms: z.array(DevicePlatformAvailability),
    hubInstalled: z.boolean(),
    agentDeviceInstalled: z.boolean(),
  }),
  /** The target is this machine: its devices are the local host's. */
  z.object({ status: z.literal("local") }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);
export type DeviceHostTestResult = z.infer<typeof DeviceHostTestResult>;
