// Rendered HTML pages follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/shared/src/htmlRender.ts
// (limits, measured widths, frame heights, the theme variables and the default palettes of
// packages/shared/src/themePalettes.ts, the guides, the base stylesheet and the bootstrap a page
// gets) and apps/server/src/mcp/toolkits/html/tools.ts (the tools' parameters and results).
import { z } from "@jhin/sdk";

/** `preview.html@1`: previewing self-contained HTML pages and rendering them into a thread (D405). */
export const PREVIEW_HTML_CAPABILITY = "preview.html";

/** Thread stream event of a rendered page (D406). */
export const HtmlRenderEvents = {
  /** `{ renderId, turnId?, title, height, heights?, html }` */
  rendered: "preview.html.rendered",
} as const;

export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
export const HTML_RENDER_MAX_CHARACTERS = 512_000;
/** The widths a rendered page is measured at. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;
/** The reply column's width, the default width of a preview. */
export const HTML_RENDER_COLUMN_WIDTH = 728;

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

export type HtmlRenderHeights = readonly (readonly [width: number, height: number])[];

// The taller of the heights measured at the nearest widths on each side: a breakpoint between
// two measured widths can make the page as tall as either.
function measuredHeight(heights: HtmlRenderHeights, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/** A page a few pixels taller than its frame would scroll inside it: the frame fits the page. */
export function htmlRenderFrameHeight(
  reference: { readonly height: number; readonly heights?: HtmlRenderHeights | undefined },
  width: number,
  contentHeight?: number,
): number {
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? reference.height));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

// --- Themes -----------------------------------------------------------------------

export type HtmlRenderAppearance = "dark" | "light";

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/** Arial-metric faces, so a preview wraps text close to how a client will. */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

export interface HtmlRenderTheme {
  readonly appearance: HtmlRenderAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

const PALETTES: Record<HtmlRenderAppearance, Record<string, string>> = {
  light: {
    "--background": "#fcfcfc",
    "--foreground": "#27272a",
    "--muted": "#fafafa",
    "--muted-foreground": "#71717b",
    "--card": "#ffffff",
    "--card-foreground": "#27272a",
    "--popover": "#ffffff",
    "--popover-foreground": "#27272a",
    "--secondary": "#fafafa",
    "--secondary-foreground": "#27272a",
    "--border": "#e4e4e7",
    "--input": "#d4d4d8",
    "--ring": "#1b4ed8",
    "--primary": "#1b4ed8",
    "--primary-foreground": "#ffffff",
    "--accent": "#1b4ed8",
    "--accent-foreground": "#ffffff",
    "--accent-surface": "#f4f4f5",
    "--accent-surface-foreground": "#18181b",
    "--destructive": "#fb2c36",
    "--destructive-foreground": "#c10007",
    "--destructive-surface": "#fcebec",
    "--warning": "#fe9a00",
    "--warning-foreground": "#bb4d00",
    "--warning-surface": "#fcf4e8",
    "--success": "#10b981",
    "--success-foreground": "#047857",
    "--info": "#3b82f6",
    "--info-foreground": "#1d4ed8",
    "--code-background": "#ffffff",
    "--code-foreground": "#27272a",
    "--chart-1": "#1b4ed8",
    "--chart-2": "#0d9488",
    "--chart-3": "#d97706",
    "--chart-4": "#9333ea",
    "--chart-5": "#e11d48",
    "--chart-6": "#65a30d",
  },
  dark: {
    "--background": "#0a0a0a",
    "--foreground": "#f5f5f5",
    "--muted": "#111111",
    "--muted-foreground": "#818181",
    "--card": "#111111",
    "--card-foreground": "#f5f5f5",
    "--popover": "#111111",
    "--popover-foreground": "#f5f5f5",
    "--secondary": "#111111",
    "--secondary-foreground": "#f5f5f5",
    "--border": "#191919",
    "--input": "#1e1e1e",
    "--ring": "#346bf1",
    "--primary": "#346bf1",
    "--primary-foreground": "#ffffff",
    "--accent": "#346bf1",
    "--accent-foreground": "#ffffff",
    "--accent-surface": "#141414",
    "--accent-surface-foreground": "#f5f5f5",
    "--destructive": "#fb414a",
    "--destructive-foreground": "#ff6467",
    "--destructive-surface": "#301214",
    "--warning": "#fe9a00",
    "--warning-foreground": "#ffb900",
    "--warning-surface": "#312108",
    "--success": "#10b981",
    "--success-foreground": "#34d399",
    "--info": "#3b82f6",
    "--info-foreground": "#60a5fa",
    "--code-background": "#111111",
    "--code-foreground": "#f5f5f5",
    "--chart-1": "#346bf1",
    "--chart-2": "#2dd4bf",
    "--chart-3": "#fbbf24",
    "--chart-4": "#c084fc",
    "--chart-5": "#fb7185",
    "--chart-6": "#a3e635",
  },
};

/** The default theme of an appearance; a client passes its own variables over it. */
export function htmlRenderTheme(
  appearance: HtmlRenderAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS,
  overrides: Readonly<Record<string, string>> = {},
): HtmlRenderTheme {
  return {
    appearance,
    variables: {
      ...PALETTES[appearance],
      "--radius": "0.625rem",
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono,
      ...overrides,
    },
  };
}

/** The variable names a page may use; a client fills them from its own theme. */
export const HTML_RENDER_VARIABLES: readonly string[] = [
  ...Object.keys(PALETTES.dark),
  "--radius",
  "--font-sans",
  "--font-mono",
];

export const HTML_RENDER_THEME_GUIDE = [
  "Jhin injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it.",
].join(" ");

export const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop by default, wider if the reader widens chat, about 360px on phones), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.",
].join(" ");

export const HTML_PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.';

// --- The page's bootstrap ---------------------------------------------------------------

const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const THEME_FRAGMENT_KEY = "jhin-theme";

/** The height a framed page reports, if `data` is its size notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** The http(s) link a framed page asks its client to open. */
export function readHtmlRenderLinkRequest(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  const url =
    typeof params === "object" && params !== null ? (params as { url?: unknown }).url : undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** What a client posts to a framed page when its theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  // Focus outlines paint inside the element, so the frame edge never clips them.
  ":where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the first paint is
// already themed: it rewrites its own <style> (a page's later :root rules still win), then drops
// the fragment. A link to another page never replaces the page: a framed page asks its client to
// open it, a top-level one opens a new window. A framed page reports its content height, measured
// as the node measures it, so its client fits the frame to the page.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("jhin-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"jhin-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`;

function bootstrapMarkup(markup: string): string {
  const defaultCss = `${rootRule(htmlRenderTheme("dark"))}@media (prefers-color-scheme: light){${rootRule(htmlRenderTheme("light"))}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="jhin-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Comments, raw text and template contents are blanked to the same length, so offsets still
// line up and inert tags cannot receive the bootstrap.
function blankNonMarkup(html: string): string {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (match[1] === "") {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
}

/** The page with the theme, the base stylesheet and the bootstrap script in its head. */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen !== null) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen !== null) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype !== null) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

// --- Commands -----------------------------------------------------------------------------

export type HtmlRenderErrorCode =
  /** Local images could not be read, are too large, or the page with them is. */
  | "HTML_RENDER_INVALID_PAGE"
  /** The node has no browser to render with, or it failed. */
  | "HTML_RENDER_UNAVAILABLE"
  | "HTML_RENDER_FAILED";

export class HtmlRenderError extends Error {
  readonly code: HtmlRenderErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: HtmlRenderErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HtmlRenderError";
    this.code = code;
    this.details = details;
  }
}

const Html = z
  .string()
  .min(1)
  .max(HTML_RENDER_MAX_CHARACTERS)
  .describe("A complete, self-contained HTML document.");

export const HtmlPreviewInput = z.object({
  html: Html,
  width: z
    .number()
    .int()
    .min(240)
    .max(1600)
    .optional()
    .describe(
      `Viewport width in CSS pixels, 240-1600. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use about 390 to check phones.`,
    ),
  appearance: z.enum(["dark", "light"]).optional().describe("Theme to preview. Defaults to dark."),
});
export type HtmlPreviewInput = z.infer<typeof HtmlPreviewInput>;

export const HtmlConsoleMessage = z.object({
  level: z.enum(["log", "info", "warning", "error"]),
  text: z.string(),
});
export type HtmlConsoleMessage = z.infer<typeof HtmlConsoleMessage>;

export const HtmlPreviewResult = z.object({
  width: z.number().int(),
  contentHeight: z.number().int(),
  capturedHeight: z.number().int(),
  consoleMessages: z.array(HtmlConsoleMessage),
  missingImages: z.array(z.string()).optional(),
  screenshot: z.object({
    mimeType: z.literal("image/png"),
    data: z.string(),
    width: z.number().int(),
    height: z.number().int(),
  }),
});
export type HtmlPreviewResult = z.infer<typeof HtmlPreviewResult>;

export const HtmlRenderInput = z.object({
  threadId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "letters, digits, . _ : -")
    .describe("The thread to show the page in."),
  html: Html,
  title: z.string().min(1).max(HTML_RENDER_MAX_TITLE_LENGTH).describe("Short name for the page."),
  height: z
    .number()
    .int()
    .describe(
      `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.`,
    ),
});
export type HtmlRenderInput = z.infer<typeof HtmlRenderInput>;

export const HtmlRenderReference = z.object({
  renderId: z.string(),
  title: z.string(),
  height: z.number(),
  heights: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
});
export type HtmlRenderReference = z.infer<typeof HtmlRenderReference>;

export const HtmlRenderResult = z.object({
  htmlRender: HtmlRenderReference,
  message: z.string(),
});

/** The payload of `preview.html.rendered`. */
export interface HtmlRenderedPayload extends HtmlRenderReference {
  readonly turnId?: string;
  readonly html: string;
}
