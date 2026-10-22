// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): deriveAuthClientMetadata and its
// inferDeviceType / inferBrowser / inferOs in apps/server/src/auth/utils.ts.

/** T3's device types. */
export const DEVICE_TYPES = ["desktop", "mobile", "tablet", "bot", "unknown"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * What a paired device says about itself (security.md D1187): it helps the
 * owner recognise a device and never decides access.
 */
export interface ClientMetadata {
  readonly deviceType: DeviceType;
  readonly os?: string;
  readonly browser?: string;
  readonly userAgent?: string;
  /** The client address as `http.server` tells it (behind a proxy, with `jhin.http.trustProxy`). */
  readonly ipAddress?: string;
}

/** A `User-Agent` is the client's: kept short. */
const MAX_USER_AGENT = 512;

function inferDeviceType(userAgent: string | undefined): DeviceType {
  if (userAgent === undefined) return "unknown";
  const normalized = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) return "bot";
  if (/ipad|tablet/.test(normalized)) return "tablet";
  if (/iphone|android.+mobile|mobile/.test(normalized)) return "mobile";
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined) return undefined;
  const normalized = userAgent.toLowerCase();
  if (/edg\//.test(normalized)) return "Edge";
  if (/opr\//.test(normalized)) return "Opera";
  if (/firefox\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined) return undefined;
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

/** The metadata of a request, with what the device presented winning over what is inferred (T3). */
export function deriveClientMetadata(input: {
  readonly userAgent: string | undefined;
  readonly ipAddress: string | undefined;
  readonly presented?: { readonly deviceType?: DeviceType; readonly os?: string };
}): ClientMetadata {
  const trimmed = input.userAgent?.trim().slice(0, MAX_USER_AGENT);
  const userAgent = trimmed === "" ? undefined : trimmed;
  const ip = input.ipAddress?.trim();
  const ipAddress = ip?.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  const os = input.presented?.os ?? inferOs(userAgent);
  const browser = inferBrowser(userAgent);
  return {
    deviceType: input.presented?.deviceType ?? inferDeviceType(userAgent),
    ...(os === undefined ? {} : { os }),
    ...(browser === undefined ? {} : { browser }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(ipAddress === undefined || ipAddress === "" ? {} : { ipAddress }),
  };
}
