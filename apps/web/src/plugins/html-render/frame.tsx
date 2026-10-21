// The frame follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/
// HtmlRenderFrame.tsx and HtmlRenderDialog.tsx, components/files/BrowserDocumentFrame.tsx (the
// sandboxed document, its theme and size messages, links) and hooks/useHtmlRenderTheme.ts.
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_VARIABLES,
  htmlRenderFrameHeight,
  htmlRenderTheme,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderedPayload,
  type HtmlRenderTheme,
} from "@jhin/preview-api";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogTitle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import { Maximize2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** The page's variables from the client's own theme, as T3's `useHtmlRenderTheme`. */
function currentTheme(): HtmlRenderTheme {
  const root = document.documentElement;
  const appearance = root.classList.contains("dark") ? "dark" : "light";
  const style = getComputedStyle(root);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const overrides: Record<string, string> = {};
  for (const name of HTML_RENDER_VARIABLES) {
    // The page's accent is the brand colour: the client's own --accent is a neutral surface.
    const source =
      name === "--accent" || name === "--chart-1"
        ? "--primary"
        : name === "--accent-foreground"
          ? "--primary-foreground"
          : name;
    const value = read(source);
    if (value !== "" && !name.startsWith("--font") && name !== "--radius") overrides[name] = value;
  }
  return htmlRenderTheme(appearance, undefined, overrides);
}

/** Follows the client's light and dark switch (the `dark` class on the root). */
function useTheme(): HtmlRenderTheme {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The sandboxed page: never same-origin, so it reaches nothing of the client. */
function HtmlDocument(props: {
  html: string;
  title: string;
  theme: HtmlRenderTheme;
  className?: string;
  height?: number;
  onContentHeight?: (height: number) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const onHeight = useRef(props.onContentHeight);
  onHeight.current = props.onContentHeight;
  const post = () =>
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(props.theme), "*");
  useEffect(() => {
    if (loaded) post();
  }, [props.theme, loaded]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) onHeight.current?.(height);
      const url = readHtmlRenderLinkRequest(event.data);
      if (url !== undefined) window.open(url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      className={cn(
        "block w-full border-0 transition-opacity duration-200",
        loaded ? "opacity-100" : "opacity-0",
        props.className,
      )}
      onLoad={() => {
        setLoaded(true);
        post();
      }}
      ref={frameRef}
      sandbox="allow-scripts allow-forms"
      srcDoc={props.html}
      style={{
        colorScheme: props.theme.appearance,
        ...(props.height === undefined ? {} : { height: `${props.height}px` }),
      }}
      title={props.title}
    />
  );
}

/** T3's HtmlRenderDialog: the page large, with its zoom. */
function FullScreen(props: {
  page: HtmlRenderedPayload;
  theme: HtmlRenderTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [zoom, setZoom] = useState(1);
  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogPopup className="w-[92vw] max-w-[92vw] p-0" variant="media">
        <DialogTitle className="sr-only">{`Expanded ${props.page.title} preview`}</DialogTitle>
        <div className="h-[min(86vh,calc(100vh-160px))] overflow-auto rounded-lg bg-background p-4">
          <div style={{ zoom }}>
            <HtmlDocument
              className="h-[calc(min(86vh,100vh-160px)-2rem)]"
              html={props.page.html}
              theme={props.theme}
              title={props.page.title}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 pb-3 text-sm">
          <span className="min-w-0 flex-1 truncate">{props.page.title}</span>
          <Button
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
            size="icon-xs"
            variant="ghost"
          >
            <MinusIcon className="size-3.5" />
          </Button>
          <Button aria-label="Reset zoom" onClick={() => setZoom(1)} size="xs" variant="ghost">
            {`${Math.round(zoom * 100)}%`}
          </Button>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= 2}
            onClick={() => setZoom(Math.min(2, zoom + 0.25))}
            size="icon-xs"
            variant="ghost"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** A rendered page in the thread: as wide as the reply, as tall as the page there. */
export function HtmlRenderFrame(props: { page: HtmlRenderedPayload }) {
  const { page } = props;
  const theme = useTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(box.clientWidth)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const height = htmlRenderFrameHeight(page, width, contentHeight);
  return (
    <div className="min-w-0 px-1 pb-4" data-html-render={page.renderId}>
      <div className="group/html-render relative" ref={boxRef}>
        <HtmlDocument
          height={height}
          html={page.html}
          onContentHeight={setContentHeight}
          theme={theme}
          title={page.title}
        />
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/html-render:opacity-100 group-focus-within/html-render:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open full screen"
                  onClick={() => setExpanded(true)}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <Maximize2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open full screen</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {expanded ? (
        <FullScreen onOpenChange={setExpanded} open={expanded} page={page} theme={theme} />
      ) : null}
    </div>
  );
}
