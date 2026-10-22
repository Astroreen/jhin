// T3's find bar (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ThreadFindBar.tsx.
// A chunk of its own (D440), loaded with the thread view; the find itself is thread-find.tsx.
// docs/plans/t3-parity.md, D801.
import { Button, InputGroup, InputGroupAddon, InputGroupInput, cn } from "@jhin/ui";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { formatCount, type ThreadFindBarProps } from "./thread-find.tsx";

/** T3's find bar: the field, "3/12", previous, next and close. */
export function ThreadFindBar(props: ThreadFindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.open) return;
    input.current?.focus();
    input.current?.select();
  }, [props.focusRequest, props.open]);
  if (!props.open) return null;

  const hasQuery = props.query.trim().length > 0;
  const noResults = hasQuery && props.total === 0;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Closes the bar rather than only clearing the field, as a search field would.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) props.onPrevious();
    else props.onNext();
  };
  return (
    <div className="absolute top-3 right-3 z-40 w-[min(22rem,calc(100%-1.5rem))] transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none">
      <InputGroup
        aria-label="Find in thread"
        className="w-full"
        onContextMenu={(event) => event.stopPropagation()}
        role="search"
        size="lg"
        variant="popover"
      >
        <InputGroupInput
          aria-label="Find in thread"
          autoComplete="off"
          maxLength={200}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in thread"
          ref={input}
          size="sm"
          spellCheck={false}
          type="search"
          value={props.query}
        />
        <InputGroupAddon align="inline-end">
          <span
            aria-live="polite"
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              noResults ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {hasQuery ? formatCount(props.active, props.total) : ""}
          </span>
          <Button
            aria-label="Previous match"
            disabled={props.total === 0}
            onClick={props.onPrevious}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            aria-label="Next match"
            disabled={props.total === 0}
            onClick={props.onNext}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
          <Button aria-label="Close find" onClick={props.onClose} size="icon-xs" variant="ghost">
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
