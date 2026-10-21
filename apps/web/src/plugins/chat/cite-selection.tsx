// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/chat/AssistantSelectionToolbar.tsx.
//
// "Cite" by a selection in an agent's message (t3-parity.md D1012): pressed, the selection goes into
// the composer as a quote of that message.
import { ASSISTANT_CITATION_MAX_TEXT_LENGTH, type AssistantCitation } from "@jhin/agent-api";
import { Button } from "@jhin/ui";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { captureAssistantTextSelection } from "../../lib/assistant-text-selection.ts";

export function CiteSelection(props: {
  /** The messages' scroller: only a selection inside it is offered. */
  readonly viewport: { readonly current: HTMLElement | null };
  /** The thread's node, which the quote names; not known for a moment while the mesh loads. */
  readonly nodeId: string | undefined;
  readonly threadId: string;
  /** Puts the quote into the composer; false when it takes none now. */
  onCite(citation: AssistantCitation): Promise<boolean>;
}) {
  const [shown, setShown] = useState<{
    selector: Omit<AssistantCitation, "version" | "nodeId" | "threadId">;
    x: number;
    y: number;
  } | null>(null);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const button = useRef<HTMLButtonElement>(null);
  const { threadId } = props;

  useLayoutEffect(() => {
    const element = button.current;
    if (element === null || shown === null) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(shown.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(shown.y, window.innerHeight - rect.height - 8))}px`;
  }, [shown]);

  useEffect(() => {
    const viewport = props.viewport.current;
    if (viewport === null) return;
    // While a pointer selects, nothing shows: T3 offers it once the selection is made.
    let selecting = false;
    const update = () => {
      if (selecting) return;
      const captured = captureAssistantTextSelection(viewport, document.getSelection());
      const messageId = captured?.source.dataset["assistantCitationSource"];
      if (captured === null || messageId === undefined) {
        setShown(null);
        return;
      }
      const rects = captured.range.getClientRects();
      const last = rects.item(rects.length - 1) ?? captured.range.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      if (last.bottom < bounds.top || last.top > bounds.bottom || last.width === 0) {
        setShown(null);
        return;
      }
      setShown({
        selector: { messageId, ...captured.selector },
        x: last.right,
        y: last.bottom + 6,
      });
    };
    const down = (event: PointerEvent) => {
      if (!viewport.contains(event.target as Node)) return;
      selecting = true;
      setShown(null);
    };
    // A release outside the window, a cancelled touch or the window losing focus end it too.
    const up = () => {
      if (!selecting) return;
      selecting = false;
      update();
    };
    // Scrolling moves what shows; nothing is read while nothing shows.
    const scrolled = () => {
      if (shownNow.current !== null) update();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    document.addEventListener("selectionchange", update);
    viewport.addEventListener("scroll", scrolled);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      document.removeEventListener("selectionchange", update);
      viewport.removeEventListener("scroll", scrolled);
    };
  }, [props.viewport, threadId]);

  if (shown === null) return null;
  const tooLong = shown.selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  // The node's id comes with the mesh's members: until then the quote cannot name it.
  const waiting = props.nodeId === undefined;
  const cite = () => {
    if (tooLong || props.nodeId === undefined) return;
    const citation: AssistantCitation = {
      version: 1,
      nodeId: props.nodeId,
      threadId,
      ...shown.selector,
    };
    void props.onCite(citation).then((done) => {
      if (!done) return;
      document.getSelection()?.removeAllRanges();
      setShown(null);
    });
  };
  return createPortal(
    <Button
      aria-label={
        tooLong
          ? "Selection is too long to cite"
          : waiting
            ? "Cite selection in composer, once the node is known"
            : "Cite selection in composer"
      }
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      disabled={tooLong || waiting}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          setShown(null);
        }
      }}
      onPointerDown={(event) => event.preventDefault()}
      ref={button}
      size="xs"
      style={{ left: shown.x, top: shown.y }}
      type="button"
      variant="glass"
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
