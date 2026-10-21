// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ThreadSearchMatch.tsx.
import { highlightParts, type ContentMatch } from "./thread-search.ts";

/** "You: …" or "Agent: …" with the query marked: why a thread matched by its messages. */
export function SearchMatchExcerpt(props: {
  match: Pick<ContentMatch, "source" | "snippet">;
  query: string;
}) {
  const isUser = props.match.source === "user";
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>
        {isUser ? "You:" : "Agent:"}
      </span>{" "}
      {highlightParts(props.match.snippet, props.query).map((part, index) =>
        part.highlighted ? (
          <mark className="bg-transparent font-semibold text-foreground" key={index}>
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
