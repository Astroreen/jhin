// Viewport sizes, presets and zoom steps follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/preview.ts and packages/shared/src/previewViewport.ts.
import { z } from "@jhin/sdk";

export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;
/** The size of a `fill` tab nobody watches, and of a new tab. */
export const DEFAULT_PREVIEW_VIEWPORT = { width: 1280, height: 800 } as const;

const Dimension = z
  .number()
  .int()
  .min(PREVIEW_VIEWPORT_MIN_DIMENSION)
  .max(PREVIEW_VIEWPORT_MAX_DIMENSION);

const withinArea = (size: { width: number; height: number }) =>
  size.width * size.height <= PREVIEW_VIEWPORT_MAX_AREA;
const AREA_MESSAGE = `Viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;

export const PREVIEW_VIEWPORT_PRESET_IDS = [
  "iphone-se",
  "iphone-xr",
  "iphone-12-pro",
  "iphone-14-pro-max",
  "pixel-7",
  "samsung-galaxy-s8-plus",
  "samsung-galaxy-s20-ultra",
  "ipad-mini",
  "ipad-air",
  "ipad-pro",
  "surface-pro-7",
  "surface-duo",
  "galaxy-z-fold-5",
  "asus-zenbook-fold",
  "samsung-galaxy-a51-71",
  "nest-hub",
  "nest-hub-max",
] as const;
export const PreviewViewportPresetId = z.enum(PREVIEW_VIEWPORT_PRESET_IDS);
export type PreviewViewportPresetId = z.infer<typeof PreviewViewportPresetId>;

export interface PreviewViewportPreset {
  readonly id: PreviewViewportPresetId;
  readonly label: string;
  readonly category: "Desktop" | "Tablet" | "Phone";
  readonly detail: string;
  readonly width: number;
  readonly height: number;
}

// Chrome DevTools' default-device order; CSS viewport sizes from Chromium's EmulatedDevices.ts.
const PRESETS: Record<PreviewViewportPresetId, Omit<PreviewViewportPreset, "id">> = {
  "iphone-se": {
    label: "iPhone SE",
    category: "Phone",
    detail: "375 × 667",
    width: 375,
    height: 667,
  },
  "iphone-xr": {
    label: "iPhone XR",
    category: "Phone",
    detail: "414 × 896",
    width: 414,
    height: 896,
  },
  "iphone-12-pro": {
    label: "iPhone 12 Pro",
    category: "Phone",
    detail: "390 × 844",
    width: 390,
    height: 844,
  },
  "iphone-14-pro-max": {
    label: "iPhone 14 Pro Max",
    category: "Phone",
    detail: "430 × 932",
    width: 430,
    height: 932,
  },
  "pixel-7": { label: "Pixel 7", category: "Phone", detail: "412 × 915", width: 412, height: 915 },
  "samsung-galaxy-s8-plus": {
    label: "Samsung Galaxy S8+",
    category: "Phone",
    detail: "360 × 740",
    width: 360,
    height: 740,
  },
  "samsung-galaxy-s20-ultra": {
    label: "Samsung Galaxy S20 Ultra",
    category: "Phone",
    detail: "412 × 915",
    width: 412,
    height: 915,
  },
  "ipad-mini": {
    label: "iPad Mini",
    category: "Tablet",
    detail: "768 × 1024",
    width: 768,
    height: 1024,
  },
  "ipad-air": {
    label: "iPad Air",
    category: "Tablet",
    detail: "820 × 1180",
    width: 820,
    height: 1180,
  },
  "ipad-pro": {
    label: "iPad Pro",
    category: "Tablet",
    detail: "1024 × 1366",
    width: 1024,
    height: 1366,
  },
  "surface-pro-7": {
    label: "Surface Pro 7",
    category: "Tablet",
    detail: "912 × 1368",
    width: 912,
    height: 1368,
  },
  "surface-duo": {
    label: "Surface Duo",
    category: "Phone",
    detail: "540 × 720",
    width: 540,
    height: 720,
  },
  "galaxy-z-fold-5": {
    label: "Galaxy Z Fold 5",
    category: "Phone",
    detail: "344 × 882",
    width: 344,
    height: 882,
  },
  "asus-zenbook-fold": {
    label: "Asus Zenbook Fold",
    category: "Tablet",
    detail: "853 × 1280",
    width: 853,
    height: 1280,
  },
  "samsung-galaxy-a51-71": {
    label: "Samsung Galaxy A51/71",
    category: "Phone",
    detail: "412 × 914",
    width: 412,
    height: 914,
  },
  "nest-hub": {
    label: "Nest Hub",
    category: "Tablet",
    detail: "1024 × 600",
    width: 1024,
    height: 600,
  },
  "nest-hub-max": {
    label: "Nest Hub Max",
    category: "Tablet",
    detail: "1280 × 800",
    width: 1280,
    height: 800,
  },
};

export const PREVIEW_VIEWPORT_PRESETS: readonly PreviewViewportPreset[] =
  PREVIEW_VIEWPORT_PRESET_IDS.map((id) => ({ id, ...PRESETS[id] }));

/** How a tab sizes its page: the watching panel, an exact size, or a device. */
export const PreviewViewportSetting = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fill") }),
  z
    .object({ mode: z.literal("freeform"), width: Dimension, height: Dimension })
    .refine(withinArea, AREA_MESSAGE),
  z
    .object({
      mode: z.literal("preset"),
      presetId: PreviewViewportPresetId,
      width: Dimension,
      height: Dimension,
    })
    .refine(withinArea, AREA_MESSAGE),
]);
export type PreviewViewportSetting = z.infer<typeof PreviewViewportSetting>;

/** The page's measured size: a narrow panel can make it smaller than any size one may pick. */
export const PreviewRenderedViewportSize = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type PreviewRenderedViewportSize = z.infer<typeof PreviewRenderedViewportSize>;

export const PreviewAppearance = z.enum(["system", "light", "dark"]);
export type PreviewAppearance = z.infer<typeof PreviewAppearance>;

/** The zoom ladder the panel steps through. */
export const PREVIEW_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;
export const PreviewZoomFactor = z
  .number()
  .refine((value) => (PREVIEW_ZOOM_LEVELS as readonly number[]).includes(value), {
    message: `Zoom must be one of ${PREVIEW_ZOOM_LEVELS.join(", ")}.`,
  });

/** T3's `resolvePreviewViewport`: the setting a resize asks for. */
export function resolvePreviewViewport(input: {
  readonly mode: "fill" | "freeform" | "preset";
  readonly preset?: PreviewViewportPresetId | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly orientation?: "portrait" | "landscape" | undefined;
}): PreviewViewportSetting {
  if (input.mode === "fill") return { mode: "fill" };
  if (input.mode === "preset" && input.preset !== undefined) {
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === input.preset);
    if (preset === undefined) throw new Error(`Unknown preview viewport preset: ${input.preset}`);
    const nativePortrait = preset.height >= preset.width;
    const swap =
      (input.orientation === "landscape" && nativePortrait) ||
      (input.orientation === "portrait" && !nativePortrait);
    return {
      mode: "preset",
      presetId: preset.id,
      width: swap ? preset.height : preset.width,
      height: swap ? preset.width : preset.height,
    };
  }
  if (input.width === undefined || input.height === undefined) {
    throw new Error("Custom preview viewport requires width and height");
  }
  return { mode: "freeform", width: input.width, height: input.height };
}
