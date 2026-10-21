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
  /** The thread's node and id, which the quote names. */
  readonly nodeId: string | undefined;
  readonly threadId: string;
  /** Puts the quote into the composer; false when it takes none now. */
  onCite(citation: AssistantCitation): boolean;
}) {
  const [shown, setShown] = useState<{
    citation: AssistantCitation;
    x: number;
    y: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { nodeId, threadId } = props;

  useLayoutEffect(() => {
    const element = button.current;
    if (element === null || shown === null) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(shown.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(shown.y, window.innerHeight - rect.height - 8))}px`;
  }, [shown]);

  useEffect(() => {
    const viewport = props.viewport.current;
    if (viewport === null || nodeId === undefined) return;
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
        citation: { version: 1, nodeId, threadId, messageId, ...captured.selector },
        x: last.right,
        y: last.bottom + 6,
      });
    };
    const down = (event: PointerEvent) => {
      if (button.current?.contains(event.target as Node)) return;
      selecting = true;
      setShown(null);
    };
    const up = () => {
      if (!selecting) return;
      selecting = false;
      update();
    };
    viewport.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("selectionchange", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("selectionchange", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [props.viewport, nodeId, threadId]);

  if (shown === null) return null;
  const tooLong = shown.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const cite = () => {
    if (tooLong || !props.onCite(shown.citation)) return;
    document.getSelection()?.removeAllRanges();
    setShown(null);
  };
  return createPortal(
    <Button
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      disabled={tooLong}
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
