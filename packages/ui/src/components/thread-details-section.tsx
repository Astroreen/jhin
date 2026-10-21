// From T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ThreadDetailsSection.tsx.
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../cn.ts";

/** A section of the thread details panel: its heading row with actions, then its rows. */
export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  /** A line above it; the first section of the panel has none. */
  separated?: boolean;
  showHeading?: boolean;
}) {
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65 first:border-t-0")}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5",
          !showHeading && "hidden",
        )}
      >
        <h3
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
          id={headingId}
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
