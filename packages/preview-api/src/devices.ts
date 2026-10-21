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

/** The node itself; device hosts over SSH are deferred. */
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
  kind: z.enum(["local"]),
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

/** What the `devices` stream and `device.state` give. */
export const DeviceState = z.object({
  hosts: z.array(DeviceHostSummary),
  devices: z.array(DeviceSummary),
  sessions: z.array(DeviceSession),
  /** Devices starting for a thread ("Starting …"). */
  booting: z.array(z.object({ hostId: z.string(), deviceId: z.string(), threadId: z.string() })),
  /** Why the last listing failed, when it did. */
  detail: z.string().optional(),
});
export type DeviceState = z.infer<typeof DeviceState>;

export type DeviceErrorCode =
  | "DEVICE_UNAVAILABLE"
  | "DEVICE_PLATFORM_UNAVAILABLE"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_BOOT_FAILED"
  | "DEVICE_OPERATION_FAILED";

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

/** Width and height of a PNG, from its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 };
  const read = (at: number) =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  return { width: read(16), height: read(20) };
}
