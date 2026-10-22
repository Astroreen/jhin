import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MAIN_WINDOW_SIZE,
  createSettingsStore,
  normalizeMainWindowBounds,
  resolveInitialMainWindowBounds,
} from "../src/settings.ts";

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

describe("window bounds", () => {
  it("restores saved bounds only when they fit on a connected display", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800 };
    expect(resolveInitialMainWindowBounds(saved, [DISPLAY])).toBe(saved);
    // The display it was on is gone.
    expect(resolveInitialMainWindowBounds({ ...saved, x: 2500 }, [DISPLAY])).toBe(
      DEFAULT_MAIN_WINDOW_SIZE,
    );
    expect(resolveInitialMainWindowBounds(null, [DISPLAY])).toBe(DEFAULT_MAIN_WINDOW_SIZE);
  });

  it("keeps whole pixels and the smallest size", () => {
    expect(normalizeMainWindowBounds({ x: 10.4, y: 20.6, width: 500, height: 1000.2 })).toEqual({
      x: 10,
      y: 21,
      width: 840,
      height: 1000,
    });
  });
});

describe("createSettingsStore", () => {
  it("keeps settings across stores and drops what it cannot read", () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-desktop-settings-"));
    Fs.writeFileSync(
      Path.join(dir, "settings.json"),
      JSON.stringify({
        updateChannel: "beta",
        mainWindowBounds: { x: 1 },
        mainWindowMaximized: true,
      }),
    );

    const first = createSettingsStore(dir);
    expect(first.get()).toEqual({ mainWindowBounds: null, mainWindowMaximized: true });
    first.update({ updateChannel: "nightly" });

    expect(createSettingsStore(dir).get()).toEqual({
      updateChannel: "nightly",
      mainWindowBounds: null,
      mainWindowMaximized: true,
    });
  });
});
