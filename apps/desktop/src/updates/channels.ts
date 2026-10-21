// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/updates/updateChannels.ts.
import type { DesktopUpdateChannel } from "@jhin/desktop-api";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;

/** A nightly build updates from the nightly track by default, a release from the stable one. */
export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
