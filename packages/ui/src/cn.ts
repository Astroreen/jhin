// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/utils.ts
import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's extra font sizes (theme.css). Unregistered, tailwind-merge reads
// text-2xs as a colour and drops it next to text-muted-foreground.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs", "4xs", "5xs"] } } });

export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs));
}
