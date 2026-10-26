// The cases follow T3 Code's browserProfile tests (MIT, see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vite-plus/test";

import {
  freshProfileName,
  PreviewBrowserSettings,
  profileName,
  resolveBrowserProfiles,
} from "../src/plugins/preview/profile-settings.ts";

describe("browser profiles of this device (D953)", () => {
  it("puts T3's built-in profiles first, then the user's, each id once", () => {
    const { profiles, defaultProfileId } = resolveBrowserProfiles(
      PreviewBrowserSettings.parse({
        profiles: [
          { id: "work", name: "Work" },
          { id: "work", name: "Work again" },
          { id: "default", name: "Shadow" },
        ],
      }),
    );
    expect(profiles.map((profile) => profile.id)).toEqual(["default", "incognito", "work"]);
    expect(defaultProfileId).toBe("default");
  });

  it("takes the chosen default, but never incognito or one that is gone", () => {
    const settings = (defaultProfileId: string) =>
      PreviewBrowserSettings.parse({ profiles: [{ id: "work", name: "Work" }], defaultProfileId });
    expect(resolveBrowserProfiles(settings("work")).defaultProfileId).toBe("work");
    expect(resolveBrowserProfiles(settings("incognito")).defaultProfileId).toBe("default");
    expect(resolveBrowserProfiles(settings("gone")).defaultProfileId).toBe("default");
  });

  it("names a new profile apart, and a removed one as T3 does", () => {
    const { profiles } = resolveBrowserProfiles(
      PreviewBrowserSettings.parse({ profiles: [{ id: "a", name: "New profile" }] }),
    );
    expect(freshProfileName(profiles, "New profile")).toBe("New profile 2");
    expect(profileName(profiles, "a")).toBe("New profile");
    expect(profileName(profiles, "zzz")).toBe("Removed profile");
  });

  it("drops a broken stored value instead of failing", () => {
    expect(PreviewBrowserSettings.parse({ profiles: "oops" }).profiles).toEqual([]);
    // One bad entry goes; the others stay.
    expect(
      PreviewBrowserSettings.parse({
        profiles: [{ id: "work", name: "Work" }, { id: "", name: "x" }, 42],
      }).profiles,
    ).toEqual([{ id: "work", name: "Work" }]);
  });
});
