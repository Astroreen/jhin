import { DEVICE_TYPES } from "@jhin/auth-api";
import { z } from "@jhin/sdk";

/** T3's device types (security.md D1187). */
export const DeviceType = z.enum(DEVICE_TYPES);

/** `ClientMetadata` of `@jhin/auth-api`, as kept in `clients.json` and listed. */
export const ClientMetadata = z.object({
  deviceType: DeviceType,
  os: z.string().optional(),
  browser: z.string().optional(),
  userAgent: z.string().optional(),
  ipAddress: z.string().optional(),
});
export type ClientMetadata = z.infer<typeof ClientMetadata>;
