// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/settings/DesktopAppSettings.ts
// and resolveInitialMainWindowBounds of apps/desktop/src/window/DesktopWindow.ts.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { DesktopUpdateChannel } from "@jhin/desktop-api";
import { z } from "@jhin/sdk";

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** T3's default size of the main window. */
export const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 780 } as const;
/** T3's smallest main window. */
export const MIN_MAIN_WINDOW_SIZE = { width: 840, height: 620 } as const;

const Bounds = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(MIN_MAIN_WINDOW_SIZE.width),
  height: z.number().int().min(MIN_MAIN_WINDOW_SIZE.height),
});

/** What the app keeps in its data folder (D515, D519); a field it cannot read is left out. */
const AppSettings = z.object({
  updateChannel: DesktopUpdateChannel.optional().catch(undefined),
  mainWindowBounds: Bounds.nullable().catch(null).default(null),
  mainWindowMaximized: z.boolean().catch(false).default(false),
});
export type AppSettings = z.output<typeof AppSettings>;

/** Whole pixels, at least the smallest size. */
export function normalizeMainWindowBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(MIN_MAIN_WINDOW_SIZE.width, Math.round(bounds.width)),
    height: Math.max(MIN_MAIN_WINDOW_SIZE.height, Math.round(bounds.height)),
  };
}

function fitsWithin(window: WindowBounds, display: WindowBounds): boolean {
  return (
    window.x >= display.x &&
    window.y >= display.y &&
    window.x + window.width <= display.x + display.width &&
    window.y + window.height <= display.y + display.height
  );
}

/** The saved bounds when they fit on a connected display, else T3's default size. */
export function resolveInitialMainWindowBounds(
  saved: WindowBounds | null,
  displays: readonly WindowBounds[],
): WindowBounds | typeof DEFAULT_MAIN_WINDOW_SIZE {
  if (saved !== null && displays.some((display) => fitsWithin(saved, display))) return saved;
  return DEFAULT_MAIN_WINDOW_SIZE;
}

/** `settings.json` in the app's data folder, read once and written atomically. */
export function createSettingsStore(userData: string) {
  const file = Path.join(userData, "settings.json");
  let settings: AppSettings;
  try {
    settings = AppSettings.parse(JSON.parse(Fs.readFileSync(file, "utf8")));
  } catch {
    settings = AppSettings.parse({});
  }
  return {
    get: (): AppSettings => settings,
    update(patch: Partial<AppSettings>): void {
      settings = { ...settings, ...patch };
      Fs.mkdirSync(userData, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      Fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
      Fs.renameSync(temporary, file);
    },
  };
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;
